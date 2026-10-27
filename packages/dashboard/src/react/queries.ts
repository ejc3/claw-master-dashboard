import {
  type Dimension,
  type EpochMs,
  HISTORY_SPAN_MS,
  HOUR_MS,
  type Series,
  type SeriesQuery,
  seriesQueryToParams,
  type TimeRange,
  WEEK_PER_WINDOW_SPAN_MS,
  WEEKLY_SMOOTHING_MS,
} from '../core'

// The page's queries, built in one place for the browser and the server: the server answers the
// first ones before sending the page, so what it renders is what the browser renders.

export type RangeName = '24h' | '7d'

export const RANGES: Record<
  RangeName,
  { label: string; ms: number; stepSeconds: number; per: string }
> = {
  '24h': { label: 'Last 24 hours', ms: 24 * HOUR_MS, stepSeconds: 300, per: 'per 5 minutes' },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * HOUR_MS, stepSeconds: 3600, per: 'per hour' },
}

/** The range the page opens with. */
export const FIRST_RANGE: RangeName = '24h'

export const SPLITS: ReadonlyArray<{
  dimension: Dimension
  label: string
  /** The tab's name on a phone. */
  shortLabel: string
  noun: string
  column: string
  /** The column's name on a phone. */
  shortColumn: string
  /** claude-master counts tokens by this split; models have no token projection. */
  tokens: boolean
  /** claude-master counts requests by this split too, the table's fallback; not by project. */
  requests: boolean
}> = [
  {
    dimension: 'client_account',
    label: 'People',
    shortLabel: 'People',
    noun: 'person',
    column: 'Person',
    shortColumn: 'Person',
    tokens: true,
    requests: true,
  },
  {
    dimension: 'client',
    label: 'Machines',
    shortLabel: 'Machines',
    noun: 'machine',
    column: 'Machine',
    shortColumn: 'Machine',
    tokens: true,
    requests: true,
  },
  {
    dimension: 'profile',
    label: 'Subscriptions',
    shortLabel: 'Subs',
    noun: 'subscription',
    column: 'Subscription',
    shortColumn: 'Sub',
    tokens: true,
    requests: true,
  },
  {
    dimension: 'project',
    label: 'Projects',
    shortLabel: 'Projects',
    noun: 'project',
    column: 'Project',
    shortColumn: 'Project',
    tokens: true,
    requests: false,
  },
  {
    dimension: 'model',
    label: 'Models',
    shortLabel: 'Models',
    noun: 'model',
    column: 'Model',
    shortColumn: 'Model',
    tokens: false,
    requests: true,
  },
]

export const KPI_STEP_SECONDS = 300
const KPI_STEP_MS = KPI_STEP_SECONDS * 1000
const READINGS_STEP_SECONDS = 600
export const READINGS_STEP_MS = READINGS_STEP_SECONDS * 1000

/** Step-aligned, so every viewer and every refresh within a step asks for the same range. */
export function rangeEnding(now: EpochMs, ms: number, stepSeconds: number): TimeRange {
  const end = Math.floor(now / (stepSeconds * 1000)) * stepSeconds * 1000
  return { start: end - ms, end }
}

/**
 * The key numbers' own five-minute range, whatever the chosen one: the last full hour ends one
 * bucket before its end, because the newest bucket is still filling (CloudWatch runs minutes
 * behind), and "the hour before" is the hour before that.
 */
export function kpiRange(now: EpochMs): TimeRange {
  return rangeEnding(now, 2 * HOUR_MS + KPI_STEP_MS, KPI_STEP_SECONDS)
}

/** The end of the last full hour of a kpiRange. */
export function kpiHourEnd(range: TimeRange): EpochMs {
  return range.end - KPI_STEP_MS
}

export function chartQuery(
  now: EpochMs,
  rangeName: RangeName,
  q: Omit<SeriesQuery, 'range' | 'stepSeconds'>,
): SeriesQuery {
  const chosen = RANGES[rangeName]
  return {
    ...q,
    range: rangeEnding(now, chosen.ms, chosen.stepSeconds),
    stepSeconds: chosen.stepSeconds,
  }
}

export function kpiQuery(now: EpochMs, metric: 'requests' | 'errors'): SeriesQuery {
  return { metric, range: kpiRange(now), stepSeconds: KPI_STEP_SECONDS }
}

/** The key numbers' tokens, by type, over the same range as their requests. */
export function kpiTokensQuery(now: EpochMs): SeriesQuery {
  return { metric: 'tokens', groupBy: 'type', range: kpiRange(now), stepSeconds: KPI_STEP_SECONDS }
}

/** The table's queries for one split: requests, and tokens by type when the split counts them. */
export function breakdownQueries(
  range: TimeRange,
  stepSeconds: number,
  split: (typeof SPLITS)[number],
): { requests: SeriesQuery | null; tokens: SeriesQuery | null } {
  const base = { range, stepSeconds, groupBy: split.dimension }
  return {
    requests: split.requests ? { ...base, metric: 'requests' } : null,
    tokens: split.tokens ? { ...base, metric: 'tokens', byType: true } : null,
  }
}

/** Tokens by subscription and type over a range: every token choice of the subscription chart. */
export function tokensByProfileQuery(now: EpochMs, rangeName: RangeName): SeriesQuery {
  return chartQuery(now, rangeName, { metric: 'tokens', groupBy: 'profile', byType: true })
}

/**
 * Used-share readings per subscription: the weekly ones for the smoothed weekly burn rate (its last
 * WEEKLY_SMOOTHING_MS), and both windows' over WEEK_PER_WINDOW_SPAN_MS for what a full 5-hour
 * window costs of the week.
 */
export function readingsQuery(
  now: EpochMs,
  metric: 'weeklyUsed' | 'fiveHourUsed' = 'weeklyUsed',
): SeriesQuery {
  return {
    metric,
    groupBy: 'profile',
    range: rangeEnding(
      now,
      Math.max(WEEKLY_SMOOTHING_MS, WEEK_PER_WINDOW_SPAN_MS),
      READINGS_STEP_SECONDS,
    ),
    stepSeconds: READINGS_STEP_SECONDS,
  }
}

/**
 * The quota readings last week is measured from (core/history): a week of them, and the two
 * days before its first hour that a pace is measured over.
 */
export function historyQuery(
  now: EpochMs,
  metric: 'weeklyUsed' | 'weeklyResetsInSeconds' | 'fiveHourUsed',
): SeriesQuery {
  return {
    metric,
    groupBy: 'profile',
    range: rangeEnding(
      now,
      HISTORY_SPAN_MS + Math.max(WEEKLY_SMOOTHING_MS, WEEK_PER_WINDOW_SPAN_MS),
      READINGS_STEP_SECONDS,
    ),
    stepSeconds: READINGS_STEP_SECONDS,
  }
}

/**
 * Tokens by subscription and type over the last day, for the paid API's output tokens (api-backup):
 * what it cost. The subscription chart's own query at 24 hours, so one answer serves both.
 */
export function backupOutputQuery(now: EpochMs): SeriesQuery {
  return tokensByProfileQuery(now, '24h')
}

/**
 * Tokens by project and type over the last day: which projects were active. The project table's
 * own query at 24 hours, so one answer serves both.
 */
export function projectsQuery(now: EpochMs): SeriesQuery {
  return chartQuery(now, '24h', { metric: 'tokens', groupBy: 'project', byType: true })
}

/** The queries once each, in order: two that ask the same thing are one request. */
function distinct(queries: SeriesQuery[]): SeriesQuery[] {
  const seen = new Set<string>()
  return queries.filter((q) => {
    const key = queryKey(q)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Every query the page makes when it opens at `now`: the range and split it opens with. */
export function firstQueries(now: EpochMs): SeriesQuery[] {
  const split = SPLITS[0]
  const chart = RANGES[FIRST_RANGE]
  const table =
    split === undefined
      ? null
      : breakdownQueries(rangeEnding(now, chart.ms, chart.stepSeconds), chart.stepSeconds, split)
  return distinct([
    chartQuery(now, FIRST_RANGE, { metric: 'requests', groupBy: 'profile' }),
    tokensByProfileQuery(now, FIRST_RANGE),
    chartQuery(now, FIRST_RANGE, { metric: 'errors' }),
    chartQuery(now, FIRST_RANGE, { metric: 'weeklyUsed', groupBy: 'profile' }),
    chartQuery(now, FIRST_RANGE, { metric: 'backupRequests' }),
    backupOutputQuery(now),
    projectsQuery(now),
    kpiQuery(now, 'requests'),
    kpiQuery(now, 'errors'),
    kpiTokensQuery(now),
    readingsQuery(now),
    readingsQuery(now, 'fiveHourUsed'),
    ...(table === null
      ? []
      : [
          ...(table.requests === null ? [] : [table.requests]),
          ...(table.tokens === null ? [] : [table.tokens]),
        ]),
  ])
}

/**
 * Every query behind the page's tabs at `now`: each range (the one shown first) and each split of
 * the breakdown table (every token choice is in one answer). Loaded in this order
 * in the background, so switching to any of them shows its answer at once.
 */
export function tabQueries(now: EpochMs, shown: RangeName): SeriesQuery[] {
  const names = [shown, ...(Object.keys(RANGES) as RangeName[]).filter((name) => name !== shown)]
  return distinct(
    names.flatMap((rangeName) => {
      const chart = RANGES[rangeName]
      const range = rangeEnding(now, chart.ms, chart.stepSeconds)
      return [
        chartQuery(now, rangeName, { metric: 'requests', groupBy: 'profile' }),
        tokensByProfileQuery(now, rangeName),
        chartQuery(now, rangeName, { metric: 'errors' }),
        chartQuery(now, rangeName, { metric: 'weeklyUsed', groupBy: 'profile' }),
        ...SPLITS.flatMap((split) => {
          const table = breakdownQueries(range, chart.stepSeconds, split)
          return [
            ...(table.requests === null ? [] : [table.requests]),
            ...(table.tokens === null ? [] : [table.tokens]),
          ]
        }),
      ]
    }),
  )
}

/** A query's identity: the parameters of its request, which the browser polls under. */
export function queryKey(query: SeriesQuery): string {
  return seriesQueryToParams(query).toString()
}

/**
 * What a query asks for apart from where its range ends. When only the end moves (each step),
 * the last answer stays on show until the next one arrives.
 */
export function queryShape(query: SeriesQuery): string {
  return [
    query.metric,
    query.groupBy ?? '',
    query.tokenType ?? '',
    query.byType === true ? 'byType' : '',
    query.stepSeconds,
    query.range.end - query.range.start,
  ].join('|')
}

/** Answers to the first queries, by queryKey, as the server fetched them. */
export type FirstSeries = Readonly<Record<string, Series[]>>
