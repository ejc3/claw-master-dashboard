import {
  burnRate,
  GAPS_HORIZON_MS,
  type PoolGaps,
  poolGaps,
  poolPace,
  poolRates,
  WEEKLY_SMOOTHING_MS,
} from './forecast'
import {
  type EpochMs,
  FIVE_HOURS_MS,
  HOUR_MS,
  type ProfileStatus,
  type Series,
  WEEK_MS,
} from './types'

/**
 * The quota readings the forecast is rebuilt from, per subscription, on one step grid: each
 * point is its bucket's start and the highest reading in it (MAX), as CloudWatch returns them.
 */
export interface QuotaHistory {
  stepMs: number
  weeklyUsed: Series[]
  weeklyResetsInSeconds: Series[]
  fiveHourUsed: Series[]
  fiveHourResetsInSeconds: Series[]
}

/** What the forecast made at one past moment said about its next week. */
export interface HindcastPoint {
  at: EpochMs
  /** Left unused when weeks reset, in one subscription's weekly limit. */
  wasted: number
  /** Demand no subscription could take, in one subscription's weekly limit. */
  clipped: number
  /** Hours with no subscription able to take work. */
  clippedHours: number
}

/** How old a weekly reading may be and still stand for the subscription (two missed polls). */
const WEEKLY_LOOKBACK_MS = 30 * 60_000

/**
 * The latest point whose whole bucket ended by `t` (a bucket holds readings up to a step after
 * its start), within `lookbackMs`; undefined when there is none.
 */
function readAt(
  points: Array<[EpochMs, number]> | undefined,
  t: EpochMs,
  stepMs: number,
  lookbackMs: number,
): [EpochMs, number] | undefined {
  if (points === undefined) return undefined
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i] as [EpochMs, number]
    if (p[0] + stepMs > t) continue
    if (p[0] + stepMs < t - lookbackMs) return undefined
    if (Number.isFinite(p[1])) return p
  }
  return undefined
}

/**
 * Every subscription's windows as the readings stood at `t`, as the snapshot would have read them
 * then. A countdown is read from its bucket's start, the time of the first reading in it. Rate
 * limits and logins are not in the history, so none is refused or expired.
 */
export function profilesAt(history: QuotaHistory, t: EpochMs): ProfileStatus[] {
  const { stepMs } = history
  const byKey = (series: Series[]) => new Map(series.map((s) => [s.key, s.points]))
  const weeklyResets = byKey(history.weeklyResetsInSeconds)
  const fiveUsed = byKey(history.fiveHourUsed)
  const fiveResets = byKey(history.fiveHourResetsInSeconds)
  const resetAt = (r: [EpochMs, number] | undefined) =>
    r === undefined ? null : r[0] + Math.max(0, r[1]) * 1000
  const profiles: ProfileStatus[] = []
  for (const s of history.weeklyUsed) {
    const used = readAt(s.points, t, stepMs, WEEKLY_LOOKBACK_MS)
    if (used === undefined) continue
    const weeklyReset = readAt(weeklyResets.get(s.key), t, stepMs, WEEKLY_LOOKBACK_MS)
    const five = readAt(fiveUsed.get(s.key), t, stepMs, FIVE_HOURS_MS)
    const fiveReset = readAt(fiveResets.get(s.key), t, stepMs, FIVE_HOURS_MS)
    profiles.push({
      profile: s.key,
      band: 'ok',
      weekly: {
        usedFraction: used[1],
        resetsAt: weeklyReset === undefined || weeklyReset[1] <= 0 ? null : resetAt(weeklyReset),
        lengthMs: WEEK_MS,
      },
      fiveHour:
        five === undefined
          ? null
          : { usedFraction: five[1], resetsAt: resetAt(fiveReset), lengthMs: FIVE_HOURS_MS },
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    })
  }
  return profiles.sort((a, b) => a.profile.localeCompare(b.profile))
}

/** Waste and clipping from one forecast: what its weekly resets throw away, and its gaps' demand. */
export function wasteAndClipping(gaps: PoolGaps, at: EpochMs): HindcastPoint {
  const end = at + GAPS_HORIZON_MS
  let gapMs = 0
  for (const g of gaps.gaps)
    gapMs += Math.max(0, Math.min(g.end ?? end, end) - Math.max(g.start, at))
  const clippedHours = gapMs / HOUR_MS
  return {
    at,
    wasted: gaps.unusedAtReset.reduce((sum, r) => sum + r.unused, 0),
    clipped: clippedHours * gaps.pace.weekly,
    clippedHours,
  }
}

/**
 * The headline's forecast as it would have been made at each of `times`, from the readings up to
 * then: the pace of the day before (poolRates, poolPace) and each subscription's windows at that
 * moment. Null at a time with no subscription read.
 */
export function hindcast(history: QuotaHistory, times: EpochMs[]): Array<HindcastPoint | null> {
  return times.map((t) => {
    const profiles = profilesAt(history, t)
    if (profiles.length === 0) return null
    // Readings from buckets that ended by t: the one starting a step before t is the last.
    const readBy = t - 1
    const smoothed = new Map<string, number | null>()
    for (const s of history.weeklyUsed) {
      smoothed.set(s.key, burnRate(s.points, readBy, WEEKLY_SMOOTHING_MS))
    }
    const rates = poolRates(history.weeklyUsed, history.fiveHourUsed, readBy)
    // The subscriptions' own pace is needed only where the readings cannot tell, and it costs a
    // whole simulation.
    const measured =
      rates.weekly !== null && rates.weekPerWindow !== null
        ? { weekly: 0, fiveHour: 0 }
        : poolGaps(profiles, t, smoothed, t).pace
    const pace = poolPace(measured, rates)
    return wasteAndClipping(poolGaps(profiles, t, smoothed, t, false, pace), t)
  })
}

/** How far back the forecasts are rebuilt: a week of them, one an hour. */
export const HINDCAST_SPAN_MS = 7 * 24 * HOUR_MS

/** The hours from HINDCAST_SPAN_MS before `end` to `end`'s hour, oldest first. */
export function hindcastTimes(end: EpochMs): EpochMs[] {
  const last = Math.floor(end / HOUR_MS) * HOUR_MS
  const times: EpochMs[] = []
  for (let t = last - HINDCAST_SPAN_MS; t <= last; t += HOUR_MS) times.push(t)
  return times
}

/**
 * hindcast at `times`, reusing `previous` for a time before `settled`: readings that old no longer
 * change, so neither does the forecast made from them. A new hour, or one near the newest
 * readings, is worked out again.
 */
export function extendHindcast(
  previous: ReadonlyMap<EpochMs, HindcastPoint | null>,
  history: QuotaHistory,
  times: EpochMs[],
  settled: EpochMs,
): Map<EpochMs, HindcastPoint | null> {
  const next = new Map<EpochMs, HindcastPoint | null>()
  const missing = times.filter((t) => {
    if (t >= settled || !previous.has(t)) return true
    next.set(t, previous.get(t) ?? null)
    return false
  })
  const worked = hindcast(history, missing)
  for (const [i, t] of missing.entries()) next.set(t, worked[i] ?? null)
  return next
}
