import 'server-only'

import { after } from 'next/server'
import type { ReactNode } from 'react'
import {
  BadQueryError,
  inTurn,
  type MetricsSource,
  type Series,
  type Snapshot,
  seriesQueryFromParams,
  timeZoneOrNull,
  UnsupportedQueryError,
} from '../core/index'
import { Dashboard } from '../react/Dashboard'
import { firstQueries, queryKey } from '../react/queries'

export interface DashboardHandlerConfig {
  /** Where the numbers come from; called per request, so a host can choose by environment. */
  source: () => MetricsSource
  /** Whether this request may read the data. Required: there is no default that admits everyone. */
  authorize: (request: Request) => boolean | Promise<boolean>
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
}

/**
 * A route handler serving `…/snapshot` and `…/series?…` under whatever path it is mounted at:
 *
 *   // app/api/claude-master/[...path]/route.ts
 *   export const { GET } = createDashboardHandler({ source, authorize })
 */
/**
 * The first path segment under `base` of a request URL, decoded ("" when there is none or its
 * escape is malformed): which dashboard a request under one API mount is for.
 */
export function firstSegmentUnder(url: string, base: string): string {
  const path = new URL(url).pathname
  const prefix = base.endsWith('/') ? base : `${base}/`
  if (!path.startsWith(prefix)) return ''
  const [first = ''] = path.slice(prefix.length).split('/')
  try {
    return decodeURIComponent(first)
  } catch {
    return ''
  }
}

export function createDashboardHandler(config: DashboardHandlerConfig): {
  GET: (request: Request) => Promise<Response>
} {
  async function GET(request: Request): Promise<Response> {
    if (!(await config.authorize(request))) {
      return json({ error: 'Sign in with an allowed account to see this dashboard.' }, 401)
    }
    const url = new URL(request.url)
    const endpoint = url.pathname.split('/').filter(Boolean).at(-1)
    try {
      if (endpoint === 'snapshot') return json(await config.source().snapshot())
      if (endpoint === 'alarms') {
        const source = config.source()
        return json(source.alarms === undefined ? [] : await source.alarms())
      }
      if (endpoint === 'series') {
        return json(await config.source().series(seriesQueryFromParams(url.searchParams)))
      }
      return json({ error: 'Not found.' }, 404)
    } catch (error) {
      if (error instanceof BadQueryError || error instanceof UnsupportedQueryError) {
        return json({ error: error.message }, 400)
      }
      // A key that may not read alarms (yet): said plainly, not as the source failing.
      const code = (error as { code?: unknown } | null)?.code
      if (endpoint === 'alarms' && (code === 'AccessDenied' || code === 'AccessDeniedException')) {
        return json({ error: "The dashboard's AWS key cannot read alarms yet." }, 403)
      }
      // The message, not the error: an SDK error can carry request details.
      console.error(
        'claw-master dashboard: the metrics source failed:',
        error instanceof Error ? error.message : String(error),
      )
      return json({ error: 'The metrics source did not answer. The page retries on its own.' }, 502)
    }
  }
  return { GET }
}

export interface DashboardPageProps {
  source: () => MetricsSource
  /** Whether the viewer may see the page; same rule as the handler's authorize. */
  authorize: () => boolean | Promise<boolean>
  /** Shown instead of the dashboard when authorize says no, e.g. a sign-in link. */
  unauthorized: ReactNode
  /** Where createDashboardHandler is mounted, e.g. "/api/claude-master". */
  apiBase: string
  /** Where a viewer whose session ended signs in again. */
  signInHref?: string
  title?: string
  /** True when the numbers are made up (the demo source); the page then says so. */
  demoData?: boolean
  /**
   * The viewer's time zone as the browser reported it: the value of the TIME_ZONE_COOKIE cookie.
   * Validated here; without it, wall-clock times appear once the page is running in the browser.
   */
  timeZone?: string | undefined
  /**
   * Keeps running, after the page is sent, a query the page stopped waiting for. Defaults to
   * Next's after(), which is waitUntil on Workers and on Vercel: without it a runtime may cancel
   * the query while a shared cache still holds it, and the browser's request for it would wait on
   * a cancelled one.
   */
  keepAlive?: (work: Promise<unknown>) => void
}

const failed = (what: string, error: unknown) =>
  console.error(
    `claw-master dashboard: ${what} failed:`,
    error instanceof Error ? error.message : String(error),
  )

/**
 * How long the page waits for the first queries before it is sent. One that takes longer is left
 * to the browser, which asks for it itself; the snapshot is always awaited.
 */
export const FIRST_QUERIES_BUDGET_MS = 2_500

/** How many of the first queries the page asks for at once. */
export const FIRST_QUERIES_AT_ONCE = 6

/** The answer, or null when it fails (thrown or rejected) or misses the budget. */
async function withinBudget<T>(
  what: string,
  run: () => Promise<T>,
  keepAlive: (work: Promise<unknown>) => void,
): Promise<T | null> {
  const work = Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      failed(what, error)
      return null
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`claw-master dashboard: ${what} missed the page's budget; the browser asks`)
      keepAlive(work)
      resolve(null)
    }, FIRST_QUERIES_BUDGET_MS)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A server component: renders the page with the snapshot and the answers to every query it opens
 * with, so the browser takes over a page that is already complete and hydrating it changes
 * nothing on screen. What the source does not answer here, the browser asks for itself.
 */
export async function DashboardPage(props: DashboardPageProps): Promise<ReactNode> {
  if (!(await props.authorize())) return props.unauthorized
  const renderedAt = Date.now()
  // A few at a time: CloudWatch runs ten Metrics Insights queries a second per account.
  const turn = inTurn(FIRST_QUERIES_AT_ONCE)
  const [initialSnapshot, answers, initialAlarms] = await Promise.all([
    // Through a promise, so a source that throws instead of rejecting fails this read alone.
    Promise.resolve()
      .then(() => props.source().snapshot())
      .catch((error: unknown): Snapshot | null => {
        failed('the first snapshot', error)
        return null
      }),
    Promise.all(
      firstQueries(renderedAt).map(async (query) => {
        const series = await withinBudget(
          `the first ${query.metric} query`,
          () => turn(() => props.source().series(query)),
          props.keepAlive ?? after,
        )
        return series === null ? null : ([queryKey(query), series] as const)
      }),
    ),
    // The alarms too, so the box is filled on the first paint; the browser asks if this fails.
    withinBudget(
      'the first alarms',
      async () => {
        const source = props.source()
        return source.alarms === undefined ? [] : source.alarms()
      },
      props.keepAlive ?? after,
    ),
  ])
  const firstSeries: Record<string, Series[]> = {}
  for (const answer of answers) if (answer !== null) firstSeries[answer[0]] = answer[1]
  return (
    <Dashboard
      initialSnapshot={initialSnapshot}
      initialAlarms={initialAlarms}
      renderedAt={renderedAt}
      firstSeries={firstSeries}
      timeZone={timeZoneOrNull(props.timeZone)}
      apiBase={props.apiBase}
      {...(props.signInHref === undefined ? {} : { signInHref: props.signInHref })}
      {...(props.title === undefined ? {} : { title: props.title })}
      {...(props.demoData === undefined ? {} : { demoData: props.demoData })}
    />
  )
}
