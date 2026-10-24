import { resolveMetric, type Statistic } from '../core/catalog'
import { validateSeriesQuery } from '../core/query'
import {
  type AlarmStatus,
  type Band,
  type Dimension,
  type EpochMs,
  FIVE_HOURS_MS,
  HOUR_MS,
  type MetricsSource,
  type ProfileStatus,
  type SemanticMetric,
  type Series,
  type SeriesQuery,
  type Snapshot,
  TOKEN_TYPES,
  type TokenType,
  WEEK_MS,
} from '../core/types'

const MINUTE_MS = 60_000

/**
 * Made-up dimension values, including the placeholders claude-master emits ('none', '0',
 * 'local', 'unknown'); none is a real profile, box, person or model.
 */
export const DEMO_VALUES: Record<Dimension, readonly string[]> = {
  profile: ['alpha', 'bravo', 'charlie', 'delta'],
  client: ['box-1', 'box-2', 'tunnel', 'local'],
  client_account: ['alice', 'bob', 'carol', 'other', 'unknown'],
  project: ['web-app', 'api-server', 'infra', 'none'],
  model: ['claude-model-large', 'claude-model-medium', 'claude-model-small'],
  status_class: ['2xx', '4xx', '5xx', 'none'],
  status: ['429', '529', '500', '401', '0'],
  reason: [
    'rate_limited',
    'weekly_exhausted',
    'reserve_reached',
    'rebalanced',
    'subscriptions_exhausted',
    'subscription_capacity_returned',
  ],
  from: ['alpha', 'bravo', 'charlie', 'delta'],
  to: ['alpha', 'bravo', 'charlie', 'delta'],
  result: ['adopted', 'failed', 'rotated_scheduled'],
  type: TOKEN_TYPES,
}

// Made-up tokens per request of each kind: cache reads dwarf fresh input, as they do in long
// agent conversations.
const TOKENS_PER_REQUEST: Record<TokenType, number> = {
  input: 900,
  output: 1100,
  cache_read: 38_000,
  cache_creation: 2_600,
}

// How traffic divides among a dimension's values, in DEMO_VALUES order.
const SHARES: Record<Dimension, readonly number[]> = {
  profile: [0.38, 0.34, 0.08, 0.2],
  client: [0.45, 0.3, 0.2, 0.05],
  client_account: [0.4, 0.3, 0.2, 0.08, 0.02],
  project: [0.5, 0.3, 0.15, 0.05],
  model: [0.35, 0.5, 0.15],
  status_class: [0, 0.55, 0.4, 0.05], // of errors; 2xx is everything else
  status: [0.5, 0.25, 0.15, 0.06, 0.04], // of errors
  reason: [0.3, 0.2, 0.2, 0.15, 0.1, 0.05],
  from: [0.25, 0.3, 0.3, 0.15],
  to: [0.35, 0.35, 0.05, 0.25],
  result: [0.8, 0.05, 0.15],
  type: [0.25, 0.25, 0.25, 0.25], // unused: tokens split by type use TOKENS_PER_REQUEST
}

/** One table drives both the snapshot and the history, so they agree. */
interface DemoProfile {
  name: string
  band: Band
  weeklyUsed: number
  weeklyResetsInMs: number
  fiveHourUsed: number | null
  fiveHourResetsInMs: number
  cooldownMs: number | null
  tokenLeftMs: number
  latencyScale: number
  /** How long ago the subscription joined the pool: it has no weekly reading before then. */
  joinedAgoMs?: number
}

const PROFILES: readonly DemoProfile[] = [
  {
    name: 'alpha',
    band: 'ok',
    weeklyUsed: 0.42,
    weeklyResetsInMs: 3.1 * 24 * HOUR_MS,
    fiveHourUsed: 0.35,
    fiveHourResetsInMs: 2.2 * HOUR_MS,
    cooldownMs: null,
    tokenLeftMs: 5.5 * HOUR_MS,
    latencyScale: 1,
  },
  {
    name: 'bravo',
    band: 'ok',
    weeklyUsed: 0.71,
    weeklyResetsInMs: 2.6 * 24 * HOUR_MS,
    fiveHourUsed: 0.82,
    fiveHourResetsInMs: 1.4 * HOUR_MS,
    cooldownMs: null,
    tokenLeftMs: 4.5 * HOUR_MS,
    latencyScale: 1.1,
  },
  {
    name: 'charlie',
    band: 'exhausted',
    weeklyUsed: 1,
    weeklyResetsInMs: 9 * HOUR_MS,
    fiveHourUsed: 1,
    fiveHourResetsInMs: 0.6 * HOUR_MS,
    cooldownMs: null,
    tokenLeftMs: 7 * HOUR_MS,
    latencyScale: 0.9,
  },
  {
    name: 'delta',
    band: 'reserve',
    weeklyUsed: 0.93,
    weeklyResetsInMs: 4.2 * 24 * HOUR_MS,
    fiveHourUsed: null,
    fiveHourResetsInMs: 0,
    cooldownMs: 7 * MINUTE_MS,
    tokenLeftMs: 6 * HOUR_MS,
    latencyScale: 1.3,
    // Added a day and a bit ago, outside the forecast's day of smoothing: the 7-day range shows
    // the pool's step up.
    joinedAgoMs: 30 * HOUR_MS,
  },
]

const TOKEN_LIFETIME_MS = 8 * HOUR_MS
// claude-master renews a login with four hours left, so a token reads between four and eight.
const TOKEN_RENEW_AT_MS = 4 * HOUR_MS
const REQUESTS_PER_MINUTE = 40

// FNV-1a folded to [0, 1): the same inputs always give the same number.
function noise(...parts: Array<string | number>): number {
  let h = 0x811c9dc5
  for (const char of parts.join('|')) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

// Busier in the working day (UTC), never idle.
function diurnal(at: EpochMs): number {
  const hour = (at / HOUR_MS) % 24
  return 1 + 0.6 * Math.sin(((hour - 9) / 24) * 2 * Math.PI)
}

// A whole count with the given mean: the noise decides the rounding, so long-run averages hold.
function count(mean: number, ...seed: Array<string | number>): number {
  return Math.floor(mean + noise(...seed))
}

/** Splits a whole count by shares so the parts are whole and add up exactly (largest remainder). */
export function split(total: number, shares: readonly number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return shares.map(() => 0)
  const exact = shares.map((s) => (total * s) / sum)
  const parts = exact.map(Math.floor)
  let left = total - parts.reduce((a, b) => a + b, 0)
  const order = exact
    .map((e, i) => ({ i, r: e - Math.floor(e) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
  for (const { i } of order) {
    if (left-- <= 0) break
    parts[i] = (parts[i] ?? 0) + 1
  }
  return parts
}

// A window's used share at time t: rising linearly to the current reading in the current window,
// and to 0.9 in every earlier one.
function usedAt(
  used: number,
  resetAt: EpochMs,
  lengthMs: number,
  now: EpochMs,
  t: EpochMs,
): number {
  const start = resetAt - lengthMs
  if (t >= start) return Math.min(used, (used * (t - start)) / Math.max(1, now - start))
  return (0.9 * mod(t - start, lengthMs)) / lengthMs
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/** What a full 5-hour window costs of the week in the demo, as measured in the pool (about 0.27). */
const DEMO_WEEK_PER_WINDOW = 0.27

/**
 * A 5-hour window's used share at `t`: the current window as usedAt, and each earlier one rising
 * from its start at the subscription's weekly pace, through DEMO_WEEK_PER_WINDOW, so both windows'
 * readings tell the same story.
 */
function fiveHourUsedAt(p: DemoProfile, now: EpochMs, t: EpochMs): number {
  if (p.fiveHourUsed === null) return Number.NaN
  const resetAt = now + p.fiveHourResetsInMs
  if (t >= resetAt - FIVE_HOURS_MS) return usedAt(p.fiveHourUsed, resetAt, FIVE_HOURS_MS, now, t)
  const weekElapsed = Math.max(HOUR_MS, WEEK_MS - p.weeklyResetsInMs)
  const perMs = p.weeklyUsed / weekElapsed / DEMO_WEEK_PER_WINDOW
  return Math.min(1, perMs * mod(t - (resetAt - FIVE_HOURS_MS), FIVE_HOURS_MS))
}

export interface DemoOptions {
  /** The clock; tests pass a fixed one so every number is reproducible. */
  now?: () => EpochMs
}

/** A source with plausible, reproducible numbers, for previews, tests and local development. */
export function createDemoSource(options: DemoOptions = {}): MetricsSource {
  const clock = options.now ?? Date.now

  // Every metric's per-minute values for each group at minute `m` (its start time).
  function minute(
    metric: SemanticMetric,
    groupBy: Dimension | undefined,
    m: EpochMs,
    now: EpochMs,
    tokenType: TokenType | undefined,
  ) {
    const keys = groupBy === undefined ? ['total'] : DEMO_VALUES[groupBy]
    const shares = groupBy === undefined ? [1] : SHARES[groupBy]
    const requests = count(
      REQUESTS_PER_MINUTE * diurnal(m) * (0.85 + 0.3 * noise('load', m)),
      'requests',
      m,
    )
    const errors = count(requests * 0.03, 'errors', m)
    const byKey = (n: number) => (groupBy === undefined ? [n] : split(n, shares))
    switch (metric) {
      case 'requests':
        if (groupBy === 'status_class')
          return [requests - errors, ...split(errors, shares.slice(1))]
        return byKey(requests)
      case 'errors':
        return byKey(errors)
      case 'tokens': {
        const of = (type: TokenType) => Math.round(requests * TOKENS_PER_REQUEST[type])
        if (groupBy === 'type') return TOKEN_TYPES.map(of)
        const total =
          tokenType === undefined ? TOKEN_TYPES.reduce((sum, t) => sum + of(t), 0) : of(tokenType)
        return byKey(total)
      }
      case 'switches':
        return byKey(count(requests * 0.01, 'switches', m))
      case 'rateLimited':
        return byKey(count(requests * 0.004, 'rateLimited', m))
      case 'backupRequests':
        return byKey(count(requests * 0.002, 'backup', m))
      case 'ttfbMs':
      case 'durationMs':
      case 'upstreamTtfbMs':
      case 'overheadMs': {
        const base = { ttfbMs: 900, durationMs: 14000, upstreamTtfbMs: 820, overheadMs: 4 }[metric]
        return keys.map((key, i) => {
          const scale = groupBy === 'profile' ? (PROFILES[i]?.latencyScale ?? 1) : 1
          return base * scale * (0.85 + 0.3 * noise(metric, key, m))
        })
      }
      case 'fiveHourUsed': {
        const values = PROFILES.map((p) =>
          p.joinedAgoMs !== undefined && m < now - p.joinedAgoMs
            ? Number.NaN
            : fiveHourUsedAt(p, now, m),
        )
        return groupBy !== undefined ? values : [reduce('MAX', values)]
      }
      case 'fiveHourResetsInSeconds': {
        const values = PROFILES.map((p) =>
          p.fiveHourUsed === null || (p.joinedAgoMs !== undefined && m < now - p.joinedAgoMs)
            ? Number.NaN
            : mod(now + p.fiveHourResetsInMs - m, FIVE_HOURS_MS) / 1000,
        )
        return groupBy !== undefined ? values : [reduce('MAX', values)]
      }
      case 'weeklyUsed':
      case 'weeklyResetsInSeconds':
      case 'tokenExpiresInSeconds': {
        const values = PROFILES.map((p) => {
          if (metric === 'weeklyUsed' && p.joinedAgoMs !== undefined && m < now - p.joinedAgoMs)
            return Number.NaN
          if (metric === 'weeklyUsed')
            return usedAt(p.weeklyUsed, now + p.weeklyResetsInMs, WEEK_MS, now, m)
          if (metric === 'weeklyResetsInSeconds')
            return mod(now + p.weeklyResetsInMs - m, WEEK_MS) / 1000
          return (
            (TOKEN_RENEW_AT_MS +
              mod(
                now + p.tokenLeftMs - TOKEN_RENEW_AT_MS - m,
                TOKEN_LIFETIME_MS - TOKEN_RENEW_AT_MS,
              )) /
            1000
          )
        })
        if (groupBy !== undefined) return values
        return [reduce(metric === 'tokenExpiresInSeconds' ? 'MIN' : 'MAX', values)]
      }
    }
  }

  // Loops, not Math.max(...values): a long bucket would overflow the call stack.
  function reduce(statistic: Statistic, values: number[]): number {
    if (values.length === 0) return 0
    switch (statistic) {
      case 'SUM':
        return values.reduce((a, b) => a + b, 0)
      case 'AVG':
        return values.reduce((a, b) => a + b, 0) / values.length
      case 'MAX':
        return values.reduce((a, b) => (b > a ? b : a))
      case 'MIN':
        return values.reduce((a, b) => (b < a ? b : a))
    }
  }

  return {
    async alarms(): Promise<AlarmStatus[]> {
      const now = clock()
      // Made-up alarms: one open, one cleared this morning, one cleared days ago.
      return [
        { name: 'claude-master-upstream-errors', state: 'ALARM', since: now - 40 * MINUTE_MS },
        { name: 'claude-master-pool-nearly-exhausted', state: 'OK', since: now - 5 * HOUR_MS },
        {
          name: 'claude-master-server-memory-pressure',
          state: 'OK',
          since: now - 3 * 24 * HOUR_MS,
        },
      ]
    },

    async snapshot(): Promise<Snapshot> {
      const now = clock()
      const asOf = now - 30_000
      const profiles: ProfileStatus[] = PROFILES.map((p) => ({
        profile: p.name,
        band: p.band,
        weekly: {
          usedFraction: p.weeklyUsed,
          resetsAt: now + p.weeklyResetsInMs,
          lengthMs: WEEK_MS,
        },
        fiveHour:
          p.fiveHourUsed === null
            ? null
            : {
                usedFraction: p.fiveHourUsed,
                resetsAt: now + p.fiveHourResetsInMs,
                lengthMs: FIVE_HOURS_MS,
              },
        rateLimitedUntil: p.cooldownMs === null ? null : now + p.cooldownMs,
        tokenExpiresAt: now + p.tokenLeftMs,
        latencyMs: {
          p50: 9000 * p.latencyScale,
          p95: 31000 * p.latencyScale,
          p99: 52000 * p.latencyScale,
        },
      }))
      return { asOf, profiles, sessions: 23, activeConnections: 41 }
    },

    async series(query: SeriesQuery): Promise<Series[]> {
      validateSeriesQuery(query)
      // Refuse what claude-master does not emit, exactly as a real source must.
      const { statistic } = resolveMetric(query.metric, query.groupBy, query.tokenType)
      const now = clock()
      const stepMs = query.stepSeconds * 1000
      const keys = query.groupBy === undefined ? ['total'] : DEMO_VALUES[query.groupBy]
      const points = keys.map((): Array<[EpochMs, number]> => [])
      // Buckets start on step boundaries; the range end is exclusive, as in GetMetricData.
      for (
        let at = Math.ceil(query.range.start / stepMs) * stepMs;
        at < query.range.end;
        at += stepMs
      ) {
        const perKey = keys.map((): number[] => [])
        // A bucket ends at its step or at the range end, whichever comes first.
        for (let m = at; m < Math.min(at + stepMs, query.range.end); m += MINUTE_MS) {
          const values = minute(query.metric, query.groupBy, m, now, query.tokenType)
          for (const [i, v] of values.entries()) perKey[i]?.push(v)
        }
        // A key with no reading in the bucket has no point, as in CloudWatch.
        for (const [i, values] of perKey.entries()) {
          const read = values.filter(Number.isFinite)
          if (read.length > 0) points[i]?.push([at, reduce(statistic, read)])
        }
      }
      return keys.map((key, i) => ({ key, points: points[i] ?? [] }))
    },
  }
}
