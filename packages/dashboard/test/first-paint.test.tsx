// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatCount,
  formatWhen,
  HOUR_MS,
  type MetricsSource,
  type ProfileStatus,
  poolGaps,
  seriesQueryFromParams,
  TOKEN_TYPES,
  timeZoneOrNull,
} from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { createDashboardHandler, DashboardPage, FIRST_QUERIES_BUDGET_MS } from '../src/next/index'
import { ForecastHistory } from '../src/react/ForecastHistory'
import { keepWhileLoading, type Loaded } from '../src/react/hooks'
import { LineChart, seriesColors } from '../src/react/LineChart'
import {
  accountColors,
  CapacityOutlook,
  calendarHref,
  ceiling,
  PoolAccounts,
  PoolOutlook,
  shortNames,
} from '../src/react/Pool'
import { chartQuery, FIRST_RANGE, firstQueries, RANGES } from '../src/react/queries'
import { RunwayCard } from '../src/react/Runway'

// A moment two minutes into a five-minute step, so a step boundary is near but not crossed.
const NOW = Date.UTC(2026, 9, 9, 18, 2, 0)
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The page measures its charts with a ResizeObserver, which jsdom lacks. This one never reports
// a size, so a chart's plot stays undrawn in both renders; the text around it is what is compared.
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('ResizeObserver', SilentResizeObserver)
  // Polls never answer: whatever the page shows comes from the server's render.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function serverPage(
  timeZone: string | undefined,
  source: MetricsSource = createDemoSource({ now: () => NOW }),
  keepAlive: (work: Promise<unknown>) => void = () => {},
): Promise<ReactElement> {
  return (await DashboardPage({
    source: () => source,
    authorize: () => true,
    unauthorized: null,
    apiBase: '/api/claude-master',
    timeZone,
    keepAlive,
  })) as ReactElement
}

/** Renders on the "server", then hydrates that HTML in the "browser". */
async function hydrated(timeZone: string | undefined, browserClock?: number) {
  const element = await serverPage(timeZone)
  const html = renderToString(element)
  if (browserClock !== undefined) vi.setSystemTime(browserClock)
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.append(container)
  const serverText = container.textContent ?? ''
  // React reports a text mismatch as recoverable, and an attribute mismatch on the console.
  const recoverable: unknown[] = []
  const consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
  act(() => {
    roots.push(hydrateRoot(container, element, { onRecoverableError: (e) => recoverable.push(e) }))
  })
  recoverable.push(...consoleErrors.mock.calls)
  consoleErrors.mockRestore()
  return { container, serverText, recoverable }
}

const kpiValues = (root: ParentNode) =>
  [...root.querySelectorAll('.cmd-kpi-value')].map((e) => e.textContent)

describe('the first paint', () => {
  it('is complete on the server: numbers, charts, the smoothed forecast and clock times', async () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE))
    const text = container.textContent ?? ''
    expect(kpiValues(container)).toHaveLength(5)
    // The alarms, filled on the server: one open, one cleared this morning.
    const alarms = [...container.querySelectorAll('.cmd-kpi')].find((e) =>
      e.textContent?.startsWith('Alarms'),
    )
    expect(alarms?.querySelector('.cmd-kpi-value')?.textContent).toBe('1 open')
    expect(alarms?.querySelector('.cmd-kpi-note')?.textContent).toBe(
      'upstream errors · 1 cleared in 24h',
    )
    expect(kpiValues(container)).not.toContain('—')
    expect(text).not.toContain('Loading…')
    // Tokens, not requests: the chart, the key number and the table's columns.
    expect(text).toContain('Tokens per 5 minutes, by subscription')
    expect(text).toContain('Tokens, last hour')
    expect(text).not.toContain('No token counts')
    const columns = [
      ...container.querySelectorAll('section[aria-labelledby="cmd-breakdown-title"] thead th'),
    ].map((e) => e.textContent)
    expect(columns).toEqual([
      'Person',
      'Input',
      'Output',
      'Cache read',
      'Cache write',
      'Tokens',
      'Share',
      'Trend',
    ])
    // The weekly burn rate from the last day's readings, not each window's average.
    // The headline from the joint forecast, and how it is worked out.
    expect(text).toMatch(/Runs out in \S+|Out now|Won't run out/)
    // The pace the forecast assumes, in one line.
    expect(text).toMatch(
      /\d of \d available now · using [\d.]+% of a weekly limit and [\d.]+% of a 5-hour limit an hour/,
    )
    // The person table, filled.
    expect(
      container.querySelectorAll('section[aria-labelledby="cmd-breakdown-title"] tbody tr').length,
    ).toBeGreaterThan(0)
    // A run-out at a clock time, not "Then".
    expect(text).not.toMatch(/Then[,;]/)
    // Each chart holds its plot's height before the browser measures its width and draws it.
    const charts = [...container.querySelectorAll<HTMLElement>('.cmd-chart')]
    // The two capacity charts at the top, the two traffic charts, the subscriptions in the pool,
    // then the breakdown's. The waste and clipping charts wait for last week in the browser.
    expect(charts).toHaveLength(6)
    expect(container.querySelector('.cmd-forecast-loading')).not.toBeNull()
    // The pool's size, drawn on the server: the demo's four subscriptions now.
    const pool = [...container.querySelectorAll('figure')].find(
      (f) => f.querySelector('figcaption')?.textContent === 'Subscriptions in the pool · 4 now',
    )
    expect(pool?.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toMatch(
      /: Subscriptions 4$/,
    )
    // Each holds its plot's height (the capacity charts are shorter) before it is measured.
    // The stacked weekly chart is a little taller than the 5-hour one. The tokens by person
    // (180px) come before the subscriptions' charts.
    expect(charts.map((chart) => chart.style.minHeight)).toEqual([
      '180px',
      '160px',
      '180px',
      '200px',
      '200px',
      '120px',
    ])
  })

  it('does not change when the browser takes over', async () => {
    // At the same instant: a later one would move the countdowns on, as the clock does.
    const { container, serverText, recoverable } = await hydrated(ZONE)
    expect(recoverable).toEqual([])
    expect(container.textContent).toBe(serverText)
  })

  it('answers every query the first screen makes, so the browser asks for none at once', async () => {
    await hydrated(ZONE)
    const asked = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input))
      .filter((url) => url.includes('/series?'))
    expect(asked).toEqual([])
  })

  it('keeps the numbers it has, unchanged, while a range moved on by one step loads', async () => {
    const { container } = await hydrated(ZONE)
    const before = kpiValues(container)
    // Past the next five-minute boundary: the key-number and chart ranges move, and nothing answers.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    expect(container.textContent).not.toContain('Loading…')
    // The same numbers: computed over the hours the kept answer covers, not the new range's.
    expect(kpiValues(container)).toEqual(before)
  })

  it("names reset times in the weekly readout only in the viewer's own zone", async () => {
    const weeklyReadout = (html: string) => {
      const box = document.createElement('div')
      box.innerHTML = html
      const weekly = [...box.querySelectorAll('figure')].find((f) =>
        f.querySelector('figcaption')?.textContent?.startsWith('Weekly limit left'),
      )
      return weekly?.querySelector('[role="slider"]')?.getAttribute('aria-valuetext') ?? ''
    }
    // Without the zone, the server writes no reset times: the browser's would differ.
    expect(weeklyReadout(renderToString(await serverPage(undefined)))).not.toContain('resets')
    // With it, they are the viewer's.
    const zoned = weeklyReadout(renderToString(await serverPage(ZONE)))
    expect(zoned).toMatch(/\(resets [^)]+\)/)
    const resets = [...zoned.matchAll(/\(resets ([^)]+)\)/g)].map((m) => m[1])
    expect(resets.length).toBeGreaterThan(0)
  })

  it('changes nothing when the browser clock is behind the server, across a step boundary', async () => {
    // The server renders a second after a five-minute boundary; the browser's clock reads a
    // second before it, so its ranges would end a step earlier than the server's answers.
    const serverAt = Date.UTC(2026, 9, 9, 18, 5, 1)
    vi.setSystemTime(serverAt)
    const element = await serverPage(ZONE, createDemoSource({ now: () => serverAt }))
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    document.body.append(container)
    const serverText = container.textContent ?? ''
    vi.setSystemTime(serverAt - 2000)
    act(() => {
      roots.push(hydrateRoot(container, element))
    })
    expect(container.textContent).toBe(serverText)
    const asked = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).includes('/series?'))
    expect(asked).toEqual([])
  })

  it('follows the browser clock again once it catches up with the server', async () => {
    // Ten minutes behind at first; then the browser's clock is corrected, a minute later.
    const serverAt = Date.UTC(2026, 9, 9, 18, 5, 1)
    vi.setSystemTime(serverAt)
    const element = await serverPage(ZONE, createDemoSource({ now: () => serverAt }))
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    document.body.append(container)
    vi.setSystemTime(serverAt - 10 * 60_000)
    act(() => {
      roots.push(hydrateRoot(container, element))
    })
    await act(async () => {
      vi.setSystemTime(serverAt + 60_000)
      await vi.advanceTimersByTimeAsync(1000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    // At 18:06 every range still ends at 18:05: none asks for buckets from the future.
    const ends = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => new URL(String(input), 'http://localhost'))
      .filter((url) => url.pathname.endsWith('/series'))
      .map((url) => Number(url.searchParams.get('end')))
    expect(Math.max(0, ...ends)).toBeLessThanOrEqual(Date.UTC(2026, 9, 9, 18, 5))
  })

  it('shows loading, not stale or zero numbers, after the page was away for hours', async () => {
    const { container } = await hydrated(ZONE)
    act(() => {
      vi.setSystemTime(NOW + 3 * HOUR_MS)
      vi.advanceTimersByTime(1000)
    })
    const values = kpiValues(container)
    expect(values.slice(0, 2)).toEqual(['—', '—'])
    expect(container.textContent).toContain('Loading…')
  })

  it('renders clock times in the reported zone, not the server process zone', async () => {
    const far = 'Pacific/Kiritimati' // UTC+14: no test machine runs in it
    expect(far).not.toBe(ZONE)
    const snapshot = await createDemoSource({ now: () => NOW }).snapshot()
    const resetsAt = snapshot.profiles[0]?.weekly.resetsAt
    if (resetsAt == null) throw new Error('the demo has no weekly reset')
    const { serverText, recoverable } = await hydrated(far)
    expect(serverText).toContain(`, ${formatWhen(resetsAt, NOW, far)}`)
    expect(serverText).not.toContain(`, ${formatWhen(resetsAt, NOW, ZONE)}`)
    // The browser then shows its own zone (the viewer moved); that is an update, not a mismatch.
    expect(recoverable).toEqual([])
  })

  it('without a reported time zone, renders countdowns only and adds clock times in the browser', async () => {
    const { container, serverText, recoverable } = await hydrated(undefined)
    // A reset's clock time ("Resets in 2h 12m, 8:14 PM") needs the viewer's zone.
    expect(serverText).not.toMatch(/Resets in [^,]+, [^R]*\d:\d{2} [AP]M/)
    expect(recoverable).toEqual([])
    expect(container.textContent).toMatch(/Resets in [^,]+, [^R]*\d:\d{2} [AP]M/)
    // The browser reports its zone for the next visit.
    expect(document.cookie).toContain(`cmd-tz=${encodeURIComponent(ZONE)}`)
  })
})

describe('the server render', () => {
  it('renders the page when a source throws instead of rejecting', async () => {
    const demo = createDemoSource({ now: () => NOW })
    const throwing: MetricsSource = {
      snapshot: () => demo.snapshot(),
      series: () => {
        throw new Error('broken source')
      },
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE, throwing))
    errors.mockRestore()
    expect(container.textContent).toContain('Subscriptions')
    expect(kpiValues(container)[0]).toBe('—')
  })

  it('does not wait past its budget for a query; the browser asks for it', async () => {
    const demo = createDemoSource({ now: () => NOW })
    const hanging: MetricsSource = {
      snapshot: () => demo.snapshot(),
      series: () => new Promise(() => {}),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kept: Array<Promise<unknown>> = []
    const page = serverPage(ZONE, hanging, (work) => kept.push(work))
    await vi.advanceTimersByTimeAsync(FIRST_QUERIES_BUDGET_MS)
    const container = document.createElement('div')
    container.innerHTML = renderToString(await page)
    warn.mockRestore()
    expect(container.textContent).toContain('Subscriptions')
    expect(kpiValues(container)[0]).toBe('—')
    // Each query it stopped waiting for keeps running after the page is sent, so a runtime does
    // not cancel it while a shared cache holds it for the browser's request.
    expect(kept).toHaveLength(firstQueries(NOW).length)
  })

  it('keeps nothing alive when every query answers in time', async () => {
    const kept: Array<Promise<unknown>> = []
    await serverPage(ZONE, createDemoSource({ now: () => NOW }), (work) => kept.push(work))
    expect(kept).toEqual([])
  })
})

describe('timeZoneOrNull', () => {
  it('takes an IANA zone the formatter accepts and nothing else', () => {
    expect(timeZoneOrNull('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(timeZoneOrNull('UTC')).toBe('UTC')
    expect(timeZoneOrNull('Etc/GMT+8')).toBe('Etc/GMT+8')
    expect(timeZoneOrNull('Mars/Olympus_Mons')).toBeNull()
    expect(timeZoneOrNull('UTC; path=/')).toBeNull()
    expect(timeZoneOrNull('')).toBeNull()
    expect(timeZoneOrNull(undefined)).toBeNull()
    expect(timeZoneOrNull('A'.repeat(65))).toBeNull()
  })
})

describe('the login line', () => {
  const profile = (tokenExpiresAt: number | null): ProfileStatus => ({
    profile: 'alpha',
    band: 'ok',
    weekly: { usedFraction: 0.4, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt,
    latencyMs: { p50: null, p95: null, p99: null },
  })
  const line = (tokenExpiresAt: number | null) => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={profile(tokenExpiresAt)} now={NOW} />)
    return [...container.querySelectorAll('.cmd-row-meta span')]
      .map((e) => e.textContent ?? '')
      .find((t) => t.includes('Login'))
  }

  it('says nothing while the login renews on schedule', () => {
    // claude-master renews with four hours left, so a fresh token reads 4 to 8 hours.
    expect(line(NOW + 4 * HOUR_MS + 8 * 60_000)).toBeUndefined()
    expect(line(NOW + 3 * HOUR_MS + 10 * 60_000)).toBeUndefined()
    expect(line(null)).toBeUndefined()
  })

  it('warns when a renewal is overdue', () => {
    expect(line(NOW + 2 * HOUR_MS + 30 * 60_000)).toBe('Login not renewed; expires in 2h 30m')
  })
})

describe('keepWhileLoading', () => {
  const ready = (data: string[]): Loaded<string[]> => ({
    state: 'ready',
    data,
    at: 0,
    failure: null,
  })
  const at = Date.UTC(2026, 9, 10, 12, 4, 59)

  it('keeps an answer while the same query, a step on, loads', () => {
    const kept = { current: null }
    keepWhileLoading(
      kept,
      chartQuery(at, '24h', { metric: 'tokens', groupBy: 'profile' }),
      ready(['all']),
    )
    const next = chartQuery(at + 2000, '24h', { metric: 'tokens', groupBy: 'profile' })
    expect(keepWhileLoading(kept, next, { state: 'loading' })).toMatchObject({ data: ['all'] })
  })

  it('never shows the answer for one token type as another', () => {
    const kept = { current: null }
    keepWhileLoading(
      kept,
      chartQuery(at, '24h', { metric: 'tokens', groupBy: 'profile' }),
      ready(['all']),
    )
    // The viewer picks Input, and the step boundary passes before it answers.
    const input = chartQuery(at + 2000, '24h', {
      metric: 'tokens',
      groupBy: 'profile',
      tokenType: 'input',
    })
    expect(keepWhileLoading(kept, input, { state: 'loading' })).toEqual({ state: 'loading' })
  })
})

describe('answers shown together, while a moved range loads', () => {
  // Hydrated at 18:02 (ranges end 18:00), then past 18:05: one query answers its moved range, the
  // others keep their answer from the range before.
  const STEP_ON = NOW + 3.5 * 60_000
  const demo = createDemoSource({ now: () => STEP_ON })

  /** Answers the series requests `fresh` picks from the demo source; the rest never answer. */
  function answer(fresh: (params: URLSearchParams) => boolean) {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost')
      if (!url.pathname.endsWith('/series') || !fresh(url.searchParams)) {
        return new Promise<Response>(() => {})
      }
      return Response.json(await demo.series(seriesQueryFromParams(url.searchParams)))
    })
  }

  async function stepOn(fresh: (params: URLSearchParams) => boolean) {
    const page = await hydrated(ZONE)
    answer(fresh)
    await act(async () => {
      vi.setSystemTime(STEP_ON)
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The moved queries' polls start, and the fresh ones answer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    return page
  }

  it('has every breakdown tab loaded in the background, so switching shows it at once', async () => {
    const page = await hydrated(ZONE)
    answer(() => true)
    // What is on screen has answered; the other tabs load one after another.
    for (let i = 0; i < 80; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
    }
    // From here on nothing answers: a tab must already have its data to show it.
    answer(() => false)
    const table = page.container.querySelector(
      'section[aria-labelledby="cmd-breakdown-title"]',
    ) as HTMLElement
    for (const name of ['Machines', 'Projects', 'Models', 'People']) {
      const tab = [...table.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').startsWith(name),
      )
      if (tab === undefined) throw new Error(`no ${name} tab`)
      act(() => tab.click())
      expect(table.textContent, name).not.toContain('Loading')
      expect(table.querySelectorAll('tbody tr').length, name).toBeGreaterThan(0)
    }
    // The other range too: its charts and table.
    const week = [...page.container.querySelectorAll('button')].find(
      (b) => b.textContent === RANGES['7d'].label,
    )
    if (week === undefined) throw new Error('no 7-day range button')
    act(() => week.click())
    expect(page.container.textContent).not.toContain('Loading')
    expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(0)
  })

  it('splits tokens by project, and never asks for requests by project', async () => {
    const page = await hydrated(ZONE)
    answer(() => true)
    const table = page.container.querySelector(
      'section[aria-labelledby="cmd-breakdown-title"]',
    ) as HTMLElement
    const tab = [...table.querySelectorAll('button')].find((b) => b.textContent === 'Projects')
    if (tab === undefined) throw new Error('no Projects tab')
    await act(async () => {
      tab.click()
      await vi.advanceTimersByTimeAsync(100)
    })
    const rows = [...table.querySelectorAll('tbody th')].map((e) => e.textContent)
    expect(rows[0]).toBe('web-app')
    expect(table.textContent).toContain('Tokens by project')
    const asked = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => new URL(String(input), 'http://localhost').searchParams)
      .filter((p) => p.get('groupBy') === 'project')
    // Each range's split is asked once (the other range in the background), and only tokens.
    const shown = asked.filter((p) => p.get('step') === String(RANGES[FIRST_RANGE].stepSeconds))
    expect(shown.length).toBe(4)
    expect(asked.every((p) => p.get('metric') === 'tokens')).toBe(true)
  })

  it('the error-rate chart has only hours both answers cover', async () => {
    const { container } = await stepOn(
      (p) => p.get('metric') === 'requests' && p.get('groupBy') === 'profile',
    )
    const figure = [...container.querySelectorAll('figure')].find((f) =>
      f.textContent?.includes('Error rate per hour'),
    )
    const toggle = figure?.querySelector('button')
    if (figure === undefined || toggle == null) throw new Error('no error-rate chart')
    act(() => toggle.click())
    const hours = [...figure.querySelectorAll('tbody tr td:first-child')].map((e) => e.textContent)
    // 18:00 is in the new requests answer only; the kept errors answer ends there.
    const sixPm = formatWhen(Date.UTC(2026, 9, 9, 18), STEP_ON)
    expect(hours.length).toBeGreaterThan(0)
    expect(hours).not.toContain(sixPm)
  })

  it('the key error rate keeps to an hour both answers cover', async () => {
    const rateTile = (root: ParentNode) => root.querySelectorAll('.cmd-kpi')[1]?.textContent
    const before = rateTile((await hydrated(ZONE)).container)
    for (const root of roots) act(() => root.unmount())
    roots = []
    document.body.innerHTML = ''
    vi.setSystemTime(NOW)
    const { container } = await stepOn(
      (p) => p.get('metric') === 'requests' && p.get('groupBy') === null,
    )
    // The rate and its error count, over the same hour as before the step.
    expect(rateTile(container)).toBe(before)
  })

  it('the table adds token types over the range all four answers cover', async () => {
    const { container } = await stepOn((p) => p.get('type') === 'input')
    const rows = [
      ...container.querySelectorAll('section[aria-labelledby="cmd-breakdown-title"] tbody tr'),
    ]
    const first = rows[0]
    const person = first?.querySelector('th')?.textContent
    const input = first?.querySelector('td')?.textContent
    if (person == null || input == null) throw new Error('no table row')
    // Input over the range every type covers: from the new start to the kept answers' end.
    const newEnd = Date.UTC(2026, 9, 9, 18, 5)
    const oldEnd = Date.UTC(2026, 9, 9, 18, 0)
    const [inputSeries] = (
      await demo.series({
        metric: 'tokens',
        tokenType: 'input',
        groupBy: 'client_account',
        range: { start: newEnd - 24 * HOUR_MS, end: newEnd },
        stepSeconds: 300,
      })
    ).filter((s) => s.key === person)
    const shared = (inputSeries?.points ?? [])
      .filter(([t]) => t >= newEnd - 24 * HOUR_MS && t < oldEnd)
      .reduce((sum, [, v]) => sum + v, 0)
    expect(input).toBe(formatCount(shared))
  })
})

describe('the status badge', () => {
  it('says a subscription Anthropic is refusing is out, and when it is back', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: null,
      rateLimitedUntil: NOW + 106 * 60_000,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
    const badge = container.querySelector('.cmd-status')
    expect(badge?.textContent).toBe('Out')
    expect(badge?.getAttribute('data-status')).toBe('out')
    expect(container.textContent).toContain('Back in 1h 46m')
    expect(container.textContent).not.toMatch(/cool/i)
  })
})

describe('the 5-hour row', () => {
  it('says no window is open once the read window has reset, not its old use', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: { usedFraction: 1, resetsAt: NOW - HOUR_MS, lengthMs: 5 * HOUR_MS },
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
    expect(container.textContent).toContain('No window open')
    expect(container.textContent).not.toContain('100%')
  })

  it('says nothing of a reset time that was not read, nor that no window is open', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0, resetsAt: null, lengthMs: 168 * HOUR_MS },
      fiveHour: { usedFraction: 0, resetsAt: null, lengthMs: 5 * HOUR_MS },
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
    expect(container.textContent).not.toContain('No window open')
    expect(container.textContent).not.toMatch(/unknown/i)
    expect(container.querySelector('.cmd-window-reset')).toBeNull()
  })

  it('is gone while Anthropic refuses the subscription, and back after', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'exhausted',
      weekly: { usedFraction: 1, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: { usedFraction: 0, resetsAt: null, lengthMs: 5 * HOUR_MS },
      rateLimitedUntil: NOW + 50 * HOUR_MS,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const render = (now: number) => {
      const container = document.createElement('div')
      container.innerHTML = renderToString(<RunwayCard status={status} now={now} />)
      return container
    }
    const out = render(NOW)
    expect(out.querySelector('.cmd-status')?.textContent).toBe('Out')
    expect(out.textContent).not.toContain('5-hour')
    expect(out.querySelectorAll('.cmd-window')).toHaveLength(1)
    // Once the refusal has ended, the 5-hour window shows again.
    expect(render(NOW + 51 * HOUR_MS).textContent).toContain('5-hour')
  })

  it('is left out without a 5-hour reading', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: null,
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
    expect(container.textContent).not.toContain('5-hour')
  })
})

describe('the account bars', () => {
  const sub = (
    profile: string,
    weekly: number,
    five: number | null,
    extra: Partial<ProfileStatus> = {},
  ): ProfileStatus => ({
    profile,
    band: 'ok',
    weekly: { usedFraction: weekly, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
    fiveHour:
      five === null ? null : { usedFraction: five, resetsAt: NOW + HOUR_MS, lengthMs: 5 * HOUR_MS },
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...extra,
  })

  it('shows each subscription by short name, what its week and 5-hour limits have left, and whether it can work', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(
      <PoolAccounts
        profiles={[
          sub('team-alpha', 0.52, 0.96),
          sub('team-bravo', 1, null),
          sub('team-charlie', 0.27, null, { rateLimitedUntil: NOW + HOUR_MS }),
          // Full when read, but its window has reset since.
          sub('team-delta', 0.4, 1, {
            fiveHour: { usedFraction: 1, resetsAt: NOW - 1, lengthMs: 5 * HOUR_MS },
          }),
        ]}
        now={NOW}
      />,
    )
    const items = [...container.querySelectorAll('.cmd-account')]
    expect(items.map((e) => e.querySelector('.cmd-account-name')?.textContent)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ])
    // bravo's poll reads its week used up, but Anthropic has not refused it: still open. charlie is
    // refused (rate-limited) and out.
    expect(items.map((e) => e.getAttribute('data-open'))).toEqual(['true', 'true', 'false', 'true'])
    // No key among the bars: one line under them says which is which.
    expect(container.querySelector('.cmd-accounts-key')).toBeNull()
    expect(container.querySelector('.cmd-accounts-legend')?.textContent?.trim()).toBe(
      'Bars: week, 5h left',
    )
    const levels = (e: Element) =>
      [...e.querySelectorAll('.cmd-account-bar')].map((b) => b.getAttribute('data-level'))
    // The 5-hour bar shows what the window really leaves: nothing for bravo (its week is used up)
    // or charlie (refused), and no more than delta's week although its window has reset.
    expect(items.map(levels)).toEqual([
      ['ok', 'high'],
      ['full', 'full'],
      ['ok', 'full'],
      ['ok', 'ok'],
    ])
    // Each bar fills with what is left, like the charts: a used-up window is an empty bar.
    const fills = (e: Element) =>
      [...e.querySelectorAll('.cmd-account-bar')].map(
        (b) => (b.querySelector('span') as HTMLElement | null)?.style.height ?? 'empty',
      )
    expect(items.map(fills)).toEqual([
      ['48%', '4%'],
      ['empty', 'empty'],
      ['73%', 'empty'],
      ['60%', '60%'],
    ])
    // Read out in full for a screen reader.
    expect(items[0]?.textContent).toContain('alpha: week 48% left, 5-hour 4.0% left')
    expect(items[1]?.textContent).toContain('bravo: week 0% left, 5-hour 0% left')
    expect(items[2]?.textContent).toContain('charlie: week 73% left, 5-hour 0% left, not available')
    expect(items[1]?.textContent).not.toContain('not available')
  })

  it('shortens names only by a shared prefix ending at a separator', () => {
    expect([...shortNames(['claude-a', 'claude-b']).values()]).toEqual(['a', 'b'])
    expect([...shortNames(['alpha', 'alpine']).values()]).toEqual(['alpha', 'alpine'])
    expect([...shortNames(['solo-one']).values()]).toEqual(['solo-one'])
  })
})

describe('the capacity charts', () => {
  it('read what is left at the forecast clock, also on the 10-minute grid between hours', () => {
    // b's week resets ten minutes in: on the 10-minute grid, not the hourly one.
    const ten = NOW + 10 * 60_000
    const profiles: ProfileStatus[] = ['a', 'b'].map((name, i) => ({
      profile: name,
      band: 'ok',
      weekly: {
        usedFraction: i === 1 ? 1 : 0.5,
        resetsAt: i === 1 ? ten : NOW + 30 * HOUR_MS,
        lengthMs: 168 * HOUR_MS,
      },
      fiveHour: null,
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }))
    const gaps = poolGaps(
      profiles,
      NOW,
      new Map([
        ['a', 0],
        ['b', 0],
      ]),
      ten,
    )
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(<CapacityOutlook gaps={gaps} profiles={profiles} now={ten} />))
    // a's half week plus b's whole one, at once.
    expect(container.querySelector('figcaption')?.textContent).toBe(
      'Weekly limit left · 150% of one subscription',
    )
  })

  it('show what is left of each window, weekly to the furthest reset and 5-hour over a day', () => {
    const profile = (name: string, weeklyResetIn: number): ProfileStatus => ({
      profile: name,
      band: 'ok',
      weekly: { usedFraction: 0.5, resetsAt: NOW + weeklyResetIn, lengthMs: 168 * HOUR_MS },
      fiveHour: { usedFraction: 0.2, resetsAt: NOW + HOUR_MS, lengthMs: 5 * HOUR_MS },
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    })
    const profiles = [profile('a', 30 * HOUR_MS), profile('b', 60 * HOUR_MS)]
    const gaps = poolGaps(
      profiles,
      NOW,
      new Map([
        ['a', 0.01],
        ['b', 0.01],
      ]),
      NOW,
    )
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(<CapacityOutlook gaps={gaps} profiles={profiles} now={NOW} />))
    const figures = [...container.querySelectorAll('figure')]
    // What is left now, in each title: each 5-hour window has 80% left, but its week only half.
    expect(figures.map((f) => f.querySelector('figcaption')?.textContent)).toEqual([
      'Weekly limit left · 100% of one subscription',
      '5-hour limit left, next 5h · 100% of one subscription',
    ])
    // No table view on these charts; the readout reads each point.
    expect(
      figures.every(
        (f) => ![...f.querySelectorAll('button')].some((b) => b.textContent === 'Show table'),
      ),
    ).toBe(true)
    const readout = (figure: Element, key: string) => {
      const slider = figure.querySelector('[role="slider"]') as HTMLElement
      act(() => {
        slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
      return slider
    }
    const weekly = figures[0] as Element
    const five = figures[1] as Element
    // Weekly hourly to half a day past the reset 60 hours out; 5-hour every ten minutes over the
    // next 5 hours.
    // Twelve hours past the reset 60 hours out, so its step is not on the edge.
    expect(readout(weekly, 'End').getAttribute('aria-valuemax')).toBe(String(72))
    expect(readout(five, 'End').getAttribute('aria-valuemax')).toBe(String(5 * 6 - 1))
    // The last weekly point is half a day after b's reset at 60 hours: b is whole again.
    expect(readout(weekly, 'End').getAttribute('aria-valuetext')).toMatch(
      /b 100% \(resets [^)]+\), total 136%$/,
    )
    // The first points: what is left now, in one subscription's limit (two half-used: 100%).
    expect(readout(weekly, 'Home').getAttribute('aria-valuetext')).toMatch(/100%$/)
    // Each 5-hour window as far as its half-used week: a 50%, b 50%.
    expect(readout(five, 'Home').getAttribute('aria-valuetext')).toMatch(
      /: a 50%, b 50%, total 100%$/,
    )
    // Reset times are the weekly chart's: the 5-hour readout has none.
    expect(five.querySelector('.cmd-tooltip-row')).not.toBeNull()
    expect(five.querySelector('.cmd-tooltip-note')).toBeNull()
  })
})

describe('a gap in the capacity charts', () => {
  it('is in the readout, not only shaded', () => {
    // Every week full until the first resets in 30 hours: no subscription can take work until then.
    const profile = (name: string, resetIn: number): ProfileStatus => ({
      profile: name,
      band: 'ok',
      weekly: { usedFraction: 1, resetsAt: NOW + resetIn, lengthMs: 168 * HOUR_MS },
      fiveHour: null,
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    })
    const profiles = [profile('a', 30 * HOUR_MS), profile('b', 60 * HOUR_MS)]
    const gaps = poolGaps(profiles, NOW, new Map(), NOW)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(<CapacityOutlook gaps={gaps} profiles={profiles} now={NOW} />))
    const weekly = container.querySelector('figure') as HTMLElement
    // The readout at the first point, inside the gap, says so.
    const slider = weekly.querySelector('[role="slider"]') as HTMLElement
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(slider.getAttribute('aria-valuetext')).toContain('None available')
    // Each subscription's row says when its week resets next.
    const rows = () =>
      [...weekly.querySelectorAll('.cmd-tooltip-row')].map((r) => r.textContent ?? '')
    expect(rows()).toEqual([
      `a– ${formatWhen(NOW + 30 * HOUR_MS, NOW)}0%`,
      `b– ${formatWhen(NOW + 60 * HOUR_MS, NOW)}0%`,
    ])
    // And the spoken readout says them too.
    expect(slider.getAttribute('aria-valuetext')).toContain(
      `a 0% (resets ${formatWhen(NOW + 30 * HOUR_MS, NOW)})`,
    )
    // And at the last point, after the gap, it does not.
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(slider.getAttribute('aria-valuetext')).not.toContain('None available')
  })
})

describe('a 5-hour gap in the capacity charts', () => {
  // Measured 600 pixels wide, so the charts draw their bands.
  class WideResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback(
        [{ contentRect: { width: 600 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
    }
    unobserve() {}
    disconnect() {}
  }
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', WideResizeObserver)
  })

  it('is shaded in its own tone and named in the readout, apart from a weekly one', () => {
    // a's week has room but its 5-hour window is full for two hours; b's week is full for 30.
    const profiles: ProfileStatus[] = [
      {
        profile: 'a',
        band: 'ok',
        weekly: { usedFraction: 0.5, resetsAt: NOW + 100 * HOUR_MS, lengthMs: 168 * HOUR_MS },
        fiveHour: { usedFraction: 1, resetsAt: NOW + 2 * HOUR_MS, lengthMs: 5 * HOUR_MS },
        rateLimitedUntil: null,
        tokenExpiresAt: null,
        latencyMs: { p50: null, p95: null, p99: null },
      },
      {
        profile: 'b',
        band: 'ok',
        weekly: { usedFraction: 1, resetsAt: NOW + 30 * HOUR_MS, lengthMs: 168 * HOUR_MS },
        fiveHour: null,
        rateLimitedUntil: null,
        tokenExpiresAt: null,
        latencyMs: { p50: null, p95: null, p99: null },
      },
    ]
    const gaps = poolGaps(profiles, NOW, new Map(), NOW, false, { weekly: 0, fiveHour: 0 })
    expect(gaps.gaps[0]).toMatchObject({ start: NOW, end: NOW + 2 * HOUR_MS, endsWith: 'fiveHour' })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(<CapacityOutlook gaps={gaps} profiles={profiles} now={NOW} />))
    const weekly = container.querySelector('figure') as HTMLElement
    expect(
      [...weekly.querySelectorAll('.cmd-band')].map((b) => b.getAttribute('data-tone')),
    ).toEqual(['secondary'])
    // The 5-hour chart shades it the same.
    const five = container.querySelectorAll('figure')[1] as HTMLElement
    expect([...five.querySelectorAll('.cmd-band')].map((b) => b.getAttribute('data-tone'))).toEqual(
      ['secondary'],
    )
    const slider = weekly.querySelector('[role="slider"]') as HTMLElement
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(slider.getAttribute('aria-valuetext')).toMatch(/; None available · 5-hour limits full$/)
  })

  it('keeps the first tone for a gap a week or a refusal ends', () => {
    const profiles: ProfileStatus[] = [
      {
        profile: 'a',
        band: 'ok',
        weekly: { usedFraction: 1, resetsAt: NOW + 30 * HOUR_MS, lengthMs: 168 * HOUR_MS },
        fiveHour: null,
        rateLimitedUntil: null,
        tokenExpiresAt: null,
        latencyMs: { p50: null, p95: null, p99: null },
      },
    ]
    const gaps = poolGaps(profiles, NOW, new Map(), NOW)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(<CapacityOutlook gaps={gaps} profiles={profiles} now={NOW} />))
    const bands = [...(container.querySelector('figure')?.querySelectorAll('.cmd-band') ?? [])]
    expect(bands.length).toBeGreaterThan(0)
    expect(bands.every((b) => !b.hasAttribute('data-tone'))).toBe(true)
  })
})

describe('a chart readout on touch', () => {
  it('opens on a tap, not a scroll, stays, and goes with a tap anywhere else', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <LineChart
          title="Requests"
          series={[
            {
              key: 'a',
              label: 'Requests',
              color: 'red',
              points: [
                [NOW, 1],
                [NOW + 60_000, 2],
              ],
            },
          ]}
          format={String}
          now={NOW}
        />,
      ),
    )
    const slider = container.querySelector('[role="slider"]') as HTMLElement
    const tap = (target: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: 0 })
      Object.defineProperty(event, 'pointerType', { value: 'touch' })
      act(() => {
        target.dispatchEvent(event)
      })
    }
    // A finger moving over the chart (a scroll, which ends in a cancel) opens nothing.
    tap(slider, 'pointerdown')
    tap(slider, 'pointermove')
    tap(slider, 'pointercancel')
    expect(container.querySelector('.cmd-tooltip')).toBeNull()
    // A tap opens it, and it stays.
    tap(slider, 'pointerdown')
    tap(slider, 'pointerup')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(container.querySelector('.cmd-tooltip')).not.toBeNull()
    // Tapping the chart again moves it, and it stays.
    tap(slider, 'pointerdown')
    tap(slider, 'pointerup')
    expect(container.querySelector('.cmd-tooltip')).not.toBeNull()
    // A tap anywhere else closes it.
    tap(document.body, 'pointerdown')
    expect(container.querySelector('.cmd-tooltip')).toBeNull()
  })
})

describe('a chart readout with a mouse', () => {
  it('follows the pointer and goes when it leaves', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <LineChart
          title="Requests"
          series={[
            {
              key: 'a',
              label: 'Requests',
              color: 'red',
              points: [
                [NOW, 1],
                [NOW + 60_000, 2],
              ],
            },
          ]}
          format={String}
          now={NOW}
        />,
      ),
    )
    const slider = container.querySelector('[role="slider"]') as HTMLElement
    const mouse = (type: string) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: 0,
        relatedTarget: document.body,
      })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      act(() => {
        slider.dispatchEvent(event)
      })
    }
    mouse('pointermove')
    expect(container.querySelector('.cmd-tooltip')).not.toBeNull()
    // React reads leaving from a pointerout to outside the element.
    mouse('pointerout')
    expect(container.querySelector('.cmd-tooltip')).toBeNull()
  })
})

describe("a subscription's detail", () => {
  const sub = (profile: string, extra: Partial<ProfileStatus> = {}): ProfileStatus => ({
    profile,
    band: 'ok',
    weekly: { usedFraction: 0.54, resetsAt: NOW + 76 * HOUR_MS, lengthMs: 168 * HOUR_MS },
    fiveHour: { usedFraction: 0.96, resetsAt: NOW + 64 * 60_000, lengthMs: 5 * HOUR_MS },
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...extra,
  })

  it('opens on a tap with when each limit resets, as calendar links, and closes with a tap away', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[
            sub('team-alpha'),
            sub('team-bravo', {
              weekly: { usedFraction: 1, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
            }),
          ]}
          now={NOW}
        />,
      ),
    )
    const [alpha, bravo] = [...container.querySelectorAll<HTMLButtonElement>('.cmd-account button')]
    if (alpha === undefined || bravo === undefined) throw new Error('no buttons')
    expect(container.querySelector('.cmd-account-detail')).toBeNull()
    act(() => alpha.click())
    const detail = container.querySelector('.cmd-account-detail') as HTMLElement
    expect(detail.textContent).toContain('team-alpha · Available')
    expect(detail.textContent).toContain('Weekly 54% used · resets')
    expect(detail.textContent).toContain('5-hour 96% used · resets')
    expect(detail.textContent).toContain('(in 1h 4m)')
    // Each reset time adds a reminder to a calendar.
    const links = [...detail.querySelectorAll('a')]
    expect(links).toHaveLength(2)
    expect(links[1]?.getAttribute('href')).toMatch(/^data:text\/calendar/)
    expect(alpha.getAttribute('aria-expanded')).toBe('true')
    // Another subscription's tap shows its own.
    act(() => bravo.click())
    expect(container.querySelector('.cmd-account-detail')?.textContent).toContain(
      'team-bravo · Nearly out · Anthropic still takes its work',
    )
    // Its week is used up, so its 5-hour window can take nothing: no 5-hour line.
    expect(container.querySelector('.cmd-account-detail')?.textContent).toContain(
      'Weekly 100% used',
    )
    expect(container.querySelector('.cmd-account-detail')?.textContent).not.toContain('5-hour')
    // A tap anywhere else closes it.
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('.cmd-account-detail')).toBeNull()
  })

  it('names the account each subscription is logged in to, in its detail and on its card', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const alpha = sub('team-alpha', { email: 'alpha@example.com' })
    act(() =>
      root.render(
        <>
          <PoolAccounts profiles={[alpha, sub('team-bravo', { email: null })]} now={NOW} />
          <RunwayCard status={alpha} now={NOW} />
        </>,
      ),
    )
    expect(container.querySelector('.cmd-row-email')?.textContent).toBe('alpha@example.com')
    const [first, second] = [
      ...container.querySelectorAll<HTMLButtonElement>('.cmd-account button'),
    ]
    act(() => first?.click())
    expect(container.querySelector('.cmd-account-email')?.textContent).toBe('alpha@example.com')
    // None reported: no line.
    act(() => second?.click())
    expect(container.querySelector('.cmd-account-email')).toBeNull()
  })

  it("says when the week leaves less than the 5-hour window's own reading", () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[
            // 13% of the window used, but only 19% of the week left: the window can use 19%.
            sub('team-alpha', {
              weekly: { usedFraction: 0.81, resetsAt: NOW + 76 * HOUR_MS, lengthMs: 168 * HOUR_MS },
              fiveHour: { usedFraction: 0.13, resetsAt: NOW + 3 * HOUR_MS, lengthMs: 5 * HOUR_MS },
            }),
            // 96% of the window used, 46% of the week left: the window's own reading stands.
            sub('team-bravo'),
          ]}
          now={NOW}
        />,
      ),
    )
    const [alpha, bravo] = [...container.querySelectorAll<HTMLButtonElement>('.cmd-account button')]
    act(() => alpha?.click())
    const detail = () => container.querySelector('.cmd-account-detail')?.textContent ?? ''
    expect(detail()).toContain('5-hour 13% used · resets')
    expect(detail()).toContain('The week has 19% left, so the 5-hour window can use only that')
    act(() => bravo?.click())
    expect(detail()).toContain('5-hour 96% used')
    expect(detail()).not.toContain('The week has')
    // A window whose reset time is unknown is still capped by its week.
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[
            sub('team-alpha', {
              weekly: { usedFraction: 0.81, resetsAt: NOW + 76 * HOUR_MS, lengthMs: 168 * HOUR_MS },
              fiveHour: { usedFraction: 0.13, resetsAt: null, lengthMs: 5 * HOUR_MS },
            }),
          ]}
          now={NOW}
        />,
      ),
    )
    act(() => container.querySelector<HTMLButtonElement>('.cmd-account button')?.click())
    expect(detail()).toContain('5-hour 13% used · reset time unknown')
    expect(detail()).toContain('The week has 19% left, so the 5-hour window can use only that')
  })

  it('follows a mouse: opens as it passes over a subscription and closes when it leaves them', () => {
    // On a wide screen the detail floats over the charts, so a mouse that has moved on must not leave it there.
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(<PoolAccounts profiles={[sub('team-alpha'), sub('team-bravo')]} now={NOW} />),
    )
    const accounts = container.querySelector('.cmd-accounts') as HTMLElement
    const [alpha] = [...container.querySelectorAll<HTMLButtonElement>('.cmd-account button')]
    if (alpha === undefined) throw new Error('no buttons')
    const pointer = (
      target: Element,
      type: string,
      pointerType: string,
      relatedTarget: Element,
    ) => {
      const event = new MouseEvent(type, { bubbles: true, relatedTarget })
      Object.defineProperty(event, 'pointerType', { value: pointerType })
      act(() => {
        target.dispatchEvent(event)
      })
    }
    // React reads entering from a pointerover from outside, and leaving from a pointerout to outside.
    pointer(alpha, 'pointerover', 'mouse', document.body)
    expect(container.querySelector('.cmd-account-detail')?.textContent).toContain('team-alpha')
    pointer(accounts, 'pointerout', 'mouse', document.body)
    expect(container.querySelector('.cmd-account-detail')).toBeNull()
    // A finger's detail stays until a tap away: a touch ends in a pointerout too.
    act(() => alpha.click())
    pointer(accounts, 'pointerout', 'touch', document.body)
    expect(container.querySelector('.cmd-account-detail')?.textContent).toContain('team-alpha')
    // With focus in the detail (a calendar link reached from the keyboard), a mouse moving away
    // leaves it and the focus where they are.
    const link = container.querySelector<HTMLAnchorElement>('.cmd-account-detail a')
    if (link === null) throw new Error('no calendar link')
    act(() => link.focus())
    pointer(accounts, 'pointerout', 'mouse', document.body)
    expect(container.querySelector('.cmd-account-detail')).not.toBeNull()
    expect(document.activeElement).toBe(link)
  })
})

describe('calendarHref', () => {
  it('is an iCalendar event at the time, in UTC, with the title', () => {
    const at = Date.UTC(2026, 9, 16, 21, 59)
    const ics = decodeURIComponent(
      calendarHref('alpha: weekly limit resets', at).split(',')[1] ?? '',
    )
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('DTSTART:20261016T215900Z')
    expect(ics).toContain('DTEND:20261016T221400Z')
    expect(ics).toContain('SUMMARY:alpha: weekly limit resets')
  })
})

describe('the banner', () => {
  const sub = (profile: string, weekly: number, resetIn: number): ProfileStatus => ({
    profile,
    band: 'ok',
    weekly: { usedFraction: weekly, resetsAt: NOW + resetIn, lengthMs: 168 * HOUR_MS },
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
  })
  const profiles = [sub('team-a', 0.3, 10 * HOUR_MS), sub('team-b', 0.8, 40 * HOUR_MS)]
  const rates = new Map([
    ['team-a', 0.01],
    ['team-b', 0.01],
  ])
  const render = () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <PoolOutlook
          gaps={poolGaps(profiles, NOW, rates, NOW)}
          gapsIfStopped={poolGaps(profiles, NOW, rates, NOW, true)}
          profiles={profiles}
          now={NOW}
        />,
      ),
    )
    return container
  }

  it('says the pace, and leaves what weekly resets will waste to the section below', () => {
    const text = render().textContent ?? ''
    // No availability line here (no detail): the pace stands alone.
    expect(text).toContain('Using 2.0% of a weekly limit and 0% of a 5-hour limit an hour')
    expect(text).not.toMatch(/wasted|Unused/i)
  })

  it('says in the waste section what weekly resets will leave unused', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <ForecastHistory
          apiBase="/api"
          now={NOW}
          gaps={poolGaps(profiles, NOW, rates, NOW)}
          profiles={profiles}
        />,
      ),
    )
    // a resets in 10h with about 60% unused; b's reset is later, after a's work moves to it.
    expect(container.textContent).toMatch(/Most wasted: a \d+%/)
  })

  it('switches the weekly chart between projected and no more use', () => {
    const container = render()
    const weeklyTitle = () =>
      container.querySelector('.cmd-capacity-weekly figcaption')?.textContent
    const tab = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('.cmd-capacity-tabs button')].find(
        (b) => b.textContent === name,
      ) as HTMLButtonElement
    expect(tab('Projected').getAttribute('aria-pressed')).toBe('true')
    const projected = weeklyTitle()
    act(() => tab('Resets').click())
    expect(tab('Resets').getAttribute('aria-pressed')).toBe('true')
    // Now the same (90% left now): the title is what is left now either way.
    expect(weeklyTitle()).toBe(projected)
    const slider = container.querySelector('.cmd-capacity-weekly [role="slider"]') as HTMLElement
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    // With no more use, every week is whole again by its reset: 200% for two subscriptions.
    expect(slider.getAttribute('aria-valuetext')).toMatch(/total 200%$/)
    // The toggle covers the 5-hour chart and says what it shows.
    expect(container.querySelector('.cmd-capacity-note')?.textContent).toContain(
      'With no more use, as limits reset',
    )
    const five = [...container.querySelectorAll('.cmd-capacity [role="slider"]')].at(
      -1,
    ) as HTMLElement
    act(() => {
      five.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    // No 5-hour readings: every window closed, so each counts as far as its week leaves, by
    // subscription like the weekly chart.
    expect(five.getAttribute('aria-valuetext')).toMatch(/: a 70%, b 20%, total 90%$/)
  })

  it("tells a subscription's unused share at its reset in its detail", () => {
    const container = render()
    const button = container.querySelector<HTMLButtonElement>('.cmd-account button')
    act(() => button?.click())
    expect(container.querySelector('.cmd-account-detail')?.textContent).toMatch(
      /At this pace \d+% of the week goes unused at its reset/,
    )
  })
})

describe("the banner's run-out line", () => {
  it('is countdowns only, with no clock times', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(
      <PoolOutlook
        gaps={poolGaps(
          [
            {
              profile: 'a',
              band: 'ok',
              weekly: { usedFraction: 0.9, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
              fiveHour: null,
              rateLimitedUntil: null,
              tokenExpiresAt: null,
              latencyMs: { p50: null, p95: null, p99: null },
            },
          ],
          NOW,
          new Map([['a', 0.1]]),
          NOW,
        )}
        profiles={null}
        now={NOW}
      />,
    )
    const facts = [...container.querySelectorAll('.cmd-forecast-facts li')].map(
      (e) => e.textContent,
    )
    expect(container.querySelector('.cmd-headline')?.textContent).toBe('Runs out in 1h for 2d')
    expect(facts.some((f) => / until /.test(f ?? ''))).toBe(false)
  })
})

describe('the paid API box', () => {
  it('shows the output tokens the paid API produced in the last day, with its requests', async () => {
    const demo = createDemoSource({ now: () => NOW })
    const source: MetricsSource = {
      snapshot: () => demo.snapshot(),
      series: async (q) => {
        const answer = await demo.series(q)
        if (q.metric === 'tokens' && q.groupBy === 'profile' && q.tokenType === 'output') {
          return [
            ...answer,
            {
              key: 'api-backup',
              points: [
                [q.range.start, 1000],
                [q.range.start + 300_000, 500],
              ],
            },
          ]
        }
        return answer
      },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE, source))
    const box = [...container.querySelectorAll('.cmd-kpi')].find((e) =>
      e.textContent?.startsWith('Paid API output tokens, last 24 hours'),
    )
    expect(box?.querySelector('.cmd-kpi-value')?.textContent).toBe('1,500')
    expect(box?.querySelector('.cmd-kpi-note')?.textContent).toMatch(/^\d[\d.,K]* requests$/)
  })
})

describe("a stacked chart's legend", () => {
  it('turns a series off and on, never the last one, and the total follows', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const points = (v: number): Array<[number, number]> => [
      [NOW, v],
      [NOW + HOUR_MS, v],
    ]
    act(() =>
      root.render(
        <LineChart
          title="Left"
          series={[
            { key: 'a', label: 'a', color: 'red', points: points(1) },
            { key: 'b', label: 'b', color: 'blue', points: points(0.5) },
          ]}
          format={(v) => `${Math.round(v * 100)}%`}
          now={NOW}
          stacked
        />,
      ),
    )
    const slider = container.querySelector('[role="slider"]') as HTMLElement
    const legend = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('.cmd-legend-toggle')].find(
        (b) => b.textContent === name,
      ) as HTMLButtonElement
    expect(slider.getAttribute('aria-valuetext')).toMatch(/a 100%, b 50%, total 150%$/)
    act(() => legend('b').click())
    // The fade runs on animation frames: let it finish.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(legend('b').getAttribute('aria-pressed')).toBe('false')
    expect(slider.getAttribute('aria-valuetext')).toMatch(/: a 100%, total 100%$/)
    // The last one on stays on.
    act(() => legend('a').click())
    expect(legend('a').getAttribute('aria-pressed')).toBe('true')
    act(() => legend('b').click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(slider.getAttribute('aria-valuetext')).toMatch(/total 150%$/)
  })
})

describe('account colors', () => {
  it('are one per subscription, whatever else a chart shows beside them', () => {
    // Eight, so the paid API's slot would land on a subscription's if it were placed first.
    const known = [
      'claude-b',
      'claude-a',
      'claude-c',
      'claude-d',
      'claude-e',
      'claude-f',
      'claude-g',
      'claude-h',
    ]
    const page = accountColors(known)
    // The tokens chart also shows the paid API, which sorts first: no subscription moves.
    const chart = seriesColors(known, ['api-backup', ...known])
    for (const name of known) expect(chart.get(name)).toBe(page.get(name))
  })

  it("paint each subscription's bars and its row in its color", () => {
    const status: ProfileStatus = {
      profile: 'claude-a',
      band: 'ok',
      weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: null,
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const colors = new Map([['claude-a', 'var(--cmd-series-3)']])
    const bars = document.createElement('div')
    bars.innerHTML = renderToString(<PoolAccounts profiles={[status]} now={NOW} colors={colors} />)
    for (const bar of bars.querySelectorAll<HTMLElement>('.cmd-account .cmd-account-bar')) {
      expect(bar.style.getPropertyValue('--cmd-account-fill')).toBe('var(--cmd-series-3)')
    }
    const row = document.createElement('div')
    row.innerHTML = renderToString(
      <RunwayCard status={status} now={NOW} color="var(--cmd-series-3)" />,
    )
    expect(row.querySelector<HTMLElement>('.cmd-profile .cmd-swatch')?.style.color).toBe(
      'var(--cmd-series-3)',
    )
  })
})

describe('the active projects box', () => {
  it('counts the projects that used tokens in the last day, and names the busiest', async () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE))
    const box = [...container.querySelectorAll('.cmd-kpi')].find((e) =>
      e.textContent?.startsWith('Active projects, last 24 hours'),
    )
    // The demo's three projects; work no launch named a project for ("none") is not one.
    expect(box?.querySelector('.cmd-kpi-value')?.textContent).toBe('3')
    expect(box?.querySelector('.cmd-kpi-note')?.textContent).toMatch(/^Most: web-app, \d+%$/)
  })
})

describe('the breakdown table', () => {
  // Subscriptions named as a team names them, with a shared prefix.
  function prefixedSource(): MetricsSource {
    const demo = createDemoSource({ now: () => NOW })
    return {
      ...demo,
      snapshot: async () => {
        const snapshot = await demo.snapshot()
        return {
          ...snapshot,
          profiles: snapshot.profiles.map((p) => ({ ...p, profile: `team-${p.profile}` })),
        }
      },
      series: async (q) => {
        const series = await demo.series(q)
        return q.groupBy === 'profile'
          ? series.map((s) => ({ ...s, key: `team-${s.key}` }))
          : series
      },
    }
  }

  it('gives a phone the name, the total and the share, and a shorter name for subscriptions', async () => {
    const source = prefixedSource()
    const { GET } = createDashboardHandler({ source: () => source, authorize: () => true })
    const fetchMock = vi.fn((url: string) =>
      GET(new Request(new URL(url, 'https://dashboard.example'))),
    )
    vi.stubGlobal('fetch', fetchMock)
    const element = await serverPage(ZONE, source)
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    document.body.append(container)
    act(() => {
      roots.push(hydrateRoot(container, element))
    })
    const tab = [...container.querySelectorAll('.cmd-tabs button')].find(
      (b) => b.querySelector('.cmd-full')?.textContent === 'Subscriptions',
    ) as HTMLButtonElement
    expect(tab.querySelector('.cmd-phone')?.textContent).toBe('Subs')
    await act(async () => {
      tab.click()
      await vi.advanceTimersByTimeAsync(100)
    })
    const table = container.querySelector('.cmd-table') as HTMLTableElement
    const head = [...table.querySelectorAll('thead th')]
    // Each token type and the trend only on a wide screen; the total only on a phone.
    expect(head.map((th) => th.className)).toEqual([
      '',
      'cmd-num cmd-full',
      'cmd-num cmd-full',
      'cmd-num cmd-full',
      'cmd-num cmd-full',
      'cmd-num cmd-phone',
      '',
      'cmd-full',
    ])
    expect(head[0]?.querySelector('.cmd-full')?.textContent).toBe('Subscription')
    expect(head[0]?.querySelector('.cmd-phone')?.textContent).toBe('Sub')
    const first = table.querySelector('tbody tr') as HTMLTableRowElement
    const name = first.querySelector('th')
    expect(name?.querySelector('.cmd-full')?.textContent).toMatch(/^team-/)
    expect(name?.querySelector('.cmd-phone')?.textContent).toBe(
      name?.querySelector('.cmd-full')?.textContent?.slice('team-'.length),
    )
    // The phone's total is every token the page was served for that subscription.
    const cells = [...first.querySelectorAll('td.cmd-num')]
    const phoneTotal = cells.find((td) => td.classList.contains('cmd-phone'))?.textContent
    expect(cells.filter((td) => td.classList.contains('cmd-full'))).toHaveLength(4)
    const key = name?.querySelector('.cmd-full')?.textContent
    // The table's four queries, one per token type, over the range on screen. Not every one is
    // fetched: output by subscription is also the paid backup's query, rendered with the page.
    const asked = fetchMock.mock.calls
      .map(([url]) => new URL(url, 'https://dashboard.example'))
      .find(
        (u) =>
          u.searchParams.get('metric') === 'tokens' &&
          u.searchParams.get('groupBy') === 'profile' &&
          u.searchParams.get('type') === 'input' &&
          u.searchParams.get('step') === String(RANGES[FIRST_RANGE].stepSeconds),
      ) as URL
    const served = TOKEN_TYPES.map((type) => {
      const u = new URL(asked)
      u.searchParams.set('type', type)
      return u
    })
    let sum = 0
    // Every subscription's tokens in the last bucket, which the stacked chart's readout totals.
    const lastBucket = new Map<number, number>()
    for (const u of served) {
      const answer = await source.series(seriesQueryFromParams(u.searchParams))
      const series = answer.find((s) => s.key === key)
      sum += series?.points.reduce((total, [, v]) => total + v, 0) ?? 0
      for (const s of answer) {
        for (const [t, v] of s.points) lastBucket.set(t, (lastBucket.get(t) ?? 0) + v)
      }
    }
    const latest = Math.max(...lastBucket.keys())
    expect(sum).toBeGreaterThan(0)
    expect(phoneTotal).toBe(formatCount(sum))

    // Above the table, the same rows over time, stacked, one band per row in the table's order,
    // named short and in each subscription's own color.
    const panel = container.querySelector('section[aria-labelledby="cmd-breakdown-title"]')
    const chart = panel?.querySelector('figure')
    expect(chart?.querySelector('figcaption')?.textContent).toBe(
      'Tokens per 5 minutes, by subscription',
    )
    const legend = [...(chart?.querySelectorAll('.cmd-legend-toggle') ?? [])]
    const rowNames = [...table.querySelectorAll('tbody th .cmd-phone')].map((e) => e.textContent)
    expect(legend.map((b) => b.textContent)).toEqual(rowNames)
    const colors = accountColors(rowNames.map((n) => `team-${n}`))
    expect(
      legend.map((b) => (b.querySelector('.cmd-swatch') as HTMLElement | null)?.style.color),
    ).toEqual(rowNames.map((n) => colors.get(`team-${n}`)))
    // Stacked: the readout adds the bands up to the pool's total at the latest point.
    expect(chart?.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toMatch(
      new RegExp(`, total ${formatCount(lastBucket.get(latest) ?? 0).replace('.', '\\.')}$`),
    )
  })
})

describe('a subscription row', () => {
  it("says Available, Nearly out at the poll's 100%, Out when refused, and no latency", () => {
    const base: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: null,
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: 1000, p95: 5000, p99: 9000 },
    }
    const render = (status: ProfileStatus) => {
      const container = document.createElement('div')
      container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
      return container
    }
    const ok = render(base)
    expect(ok.querySelector('.cmd-status')?.textContent).toBe('Available')
    expect(ok.textContent).not.toMatch(/p95|headroom/)
    // The poll's 100%: Anthropic still takes its work, so nearly out, not out, and no back time.
    const nearlyOut = render({ ...base, weekly: { ...base.weekly, usedFraction: 1 } })
    expect(nearlyOut.querySelector('.cmd-status')?.textContent).toBe('Nearly out')
    expect(nearlyOut.textContent).not.toContain('Back in')
    // Refused until the week resets: out, and back then.
    const refused = render({
      ...base,
      weekly: { ...base.weekly, usedFraction: 1 },
      rateLimitedUntil: base.weekly.resetsAt,
    })
    expect(refused.querySelector('.cmd-status')?.textContent).toBe('Out')
    expect(refused.textContent).toContain('Back in 2d')
    // The poll's 100% and no work taken lately: out, back when the week resets.
    const usedUp = render({
      ...base,
      weekly: { ...base.weekly, usedFraction: 1 },
      acceptedAt: null,
    })
    expect(usedUp.querySelector('.cmd-status')?.textContent).toBe('Out')
    expect(usedUp.textContent).toContain('Back in 2d')
    // While it is out, no 5-hour row (no pace to run out at); with recent work it keeps it.
    const withFive = {
      ...base,
      weekly: { ...base.weekly, usedFraction: 1 },
      fiveHour: { usedFraction: 0.8, resetsAt: NOW + 2 * HOUR_MS, lengthMs: 5 * HOUR_MS },
    }
    expect(render({ ...withFive, acceptedAt: null }).textContent).not.toContain('5-hour')
    expect(render({ ...withFive, acceptedAt: NOW - 60_000 }).textContent).toContain('5-hour')
    // The same with work taken a minute ago: nearly out.
    const stillTaking = render({
      ...base,
      weekly: { ...base.weekly, usedFraction: 1 },
      acceptedAt: NOW - 60_000,
    })
    expect(stillTaking.querySelector('.cmd-status')?.textContent).toBe('Nearly out')
  })
})

describe('the capacity advice', () => {
  it('appears under the waste chart once the page is up, not in the first paint', async () => {
    const { container, serverText } = await hydrated(ZONE)
    expect(serverText).not.toMatch(/[Cc]ould cancel|subscriptions? (by|now|in)/)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const facts = [...container.querySelectorAll('.cmd-forecast-facts li')].map(
      (e) => e.textContent ?? '',
    )
    // At the demo's pace (the 5-hour one following from the weekly) the pool covers 94% of the
    // week: one more subscription, by a clock time (in the browser's zone once it has taken over;
    // adviceLine's tests check the times).
    const plan = /^Add 1 subscription by .+ for tokens 95% of the week \(94% now\)$/
    expect(facts.some((f) => plan.test(f))).toBe(true)
  })
})

describe('the capacity advice, from a late snapshot', () => {
  it('is worked out at the clock, not the snapshot time: an ended cooldown is not a gap', async () => {
    const demo = createDemoSource({ now: () => NOW })
    // Read twelve hours ago, every subscription rate-limited until an hour ago; fresh weeks that
    // reset in 60 hours, plenty at the demo's pace.
    const source: MetricsSource = {
      ...demo,
      snapshot: async () => {
        const s = await demo.snapshot()
        return {
          ...s,
          asOf: NOW - 12 * HOUR_MS,
          profiles: s.profiles.map((p) => ({
            ...p,
            band: 'ok' as const,
            weekly: { usedFraction: 0, resetsAt: NOW + 60 * HOUR_MS, lengthMs: 168 * HOUR_MS },
            fiveHour: null,
            rateLimitedUntil: NOW - HOUR_MS,
            tokenExpiresAt: null,
          })),
        }
      },
    }
    const element = await serverPage(ZONE, source)
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    document.body.append(container)
    act(() => {
      roots.push(hydrateRoot(container, element))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const facts = [...container.querySelectorAll('.cmd-forecast-facts li')].map(
      (e) => e.textContent ?? '',
    )
    expect(facts.some((f) => f.startsWith('Add '))).toBe(false)
  })
})

describe('out means refused', () => {
  // Every subscription's week read as used up by the poll; refused by Anthropic or not.
  const pollFull = (refused: boolean): MetricsSource => {
    const demo = createDemoSource({ now: () => NOW })
    return {
      ...demo,
      snapshot: async () => {
        const s = await demo.snapshot()
        return {
          ...s,
          profiles: s.profiles.map((p) => ({
            ...p,
            band: 'exhausted' as const,
            weekly: { usedFraction: 1, resetsAt: NOW + 30 * HOUR_MS, lengthMs: 168 * HOUR_MS },
            fiveHour: null,
            rateLimitedUntil: refused ? NOW + 30 * HOUR_MS : null,
            tokenExpiresAt: null,
          })),
        }
      },
    }
  }
  const headline = async (source: MetricsSource) => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE, source))
    return {
      headline: container.querySelector('#cmd-pool-headline')?.textContent ?? '',
      out: container.querySelectorAll('.cmd-account[data-open="false"]').length,
    }
  }

  it('says out now only when Anthropic refuses every subscription', async () => {
    const refused = await headline(pollFull(true))
    expect(refused.headline).toMatch(/^Out now/)
    expect(refused.out).toBe(4)
    // The poll's 100% with no refusal: nearly out, still taking work, so it runs out shortly.
    const notRefused = await headline(pollFull(false))
    expect(notRefused.headline).not.toMatch(/^Out now/)
    expect(notRefused.headline).toMatch(/^Runs out in/)
    expect(notRefused.out).toBe(0)
  })

  it('measures the pace at the readings, even when a window has reset since', async () => {
    // Read two minutes ago: every 5-hour window half used, all resetting a minute ago.
    const demo = createDemoSource({ now: () => NOW })
    const source: MetricsSource = {
      ...demo,
      snapshot: async () => {
        const s = await demo.snapshot()
        return {
          ...s,
          asOf: NOW - 2 * 60_000,
          profiles: s.profiles.map((p) => ({
            ...p,
            band: 'ok' as const,
            weekly: { usedFraction: 0.5, resetsAt: NOW + 100 * HOUR_MS, lengthMs: 168 * HOUR_MS },
            fiveHour: { usedFraction: 0.5, resetsAt: NOW - 60_000, lengthMs: 5 * HOUR_MS },
            rateLimitedUntil: null,
            tokenExpiresAt: null,
          })),
        }
      },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE, source))
    const pace = [...container.querySelectorAll('.cmd-facts li')]
      .map((e) => e.textContent ?? '')
      .find((t) => t.includes('of a 5-hour limit an hour'))
    expect(pace).toBeDefined()
    expect(pace).not.toMatch(/ 0% of a 5-hour limit an hour/)
  })

  it('counts the last percent from now, not from a reading minutes old', async () => {
    // Every 5-hour window read full five minutes ago at a fast pace, none refused: the last percent
    // would be spent by now if counted from the reading.
    const demo = createDemoSource({ now: () => NOW })
    const source: MetricsSource = {
      ...demo,
      snapshot: async () => {
        const s = await demo.snapshot()
        return {
          ...s,
          asOf: NOW - 5 * 60_000,
          profiles: s.profiles.map((p) => ({
            ...p,
            band: 'ok' as const,
            weekly: { usedFraction: 0.5, resetsAt: NOW + 100 * HOUR_MS, lengthMs: 168 * HOUR_MS },
            fiveHour: { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: 5 * HOUR_MS },
            rateLimitedUntil: null,
            tokenExpiresAt: null,
          })),
        }
      },
    }
    const { headline: text } = await headline(source)
    expect(text).not.toMatch(/^Out now/)
  })
})

describe('the name', () => {
  it('is claw-master', async () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE))
    expect(container.querySelector('.cmd-title')?.firstChild?.textContent).toBe('claw-master')
    // Nowhere on the first paint the old name (the alarms keep it in CloudWatch; the page strips it).
    expect(container.textContent).not.toContain('claude-master')
  })
})

describe("a capacity chart's top", () => {
  it('is its peak up to the next whole subscription, within the pool', () => {
    const at = (v: number): [number, number] => [NOW, v]
    // A 5-hour chart under one subscription's worth: 100%, not the pool's 400%.
    expect(ceiling([at(0.77), at(0.2)], 4)).toBe(1)
    expect(ceiling([at(2.3)], 4)).toBe(3)
    expect(ceiling([at(2)], 4)).toBe(2)
    expect(ceiling([at(3.5)], 3)).toBe(3)
    // Nothing left still draws a 100% axis.
    expect(ceiling([at(0)], 4)).toBe(1)
    expect(ceiling([], 4)).toBe(1)
  })
})
