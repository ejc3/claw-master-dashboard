import {
  burnRate,
  GAPS_HORIZON_MS,
  type PoolGaps,
  poolGaps,
  poolPace,
  poolRates,
  riseOver,
  WEEKLY_SMOOTHING_MS,
} from './forecast'
import {
  type EpochMs,
  FIVE_HOURS_MS,
  HOUR_MS,
  type ProfileStatus,
  type QuotaWindow,
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
  // A countdown is read from its bucket's start, so the window it names began up to a step before
  // the time it gives. One that may have begun after the used share's bucket started makes that
  // share (its bucket's highest) possibly the window before's, a full one at a reset: the new
  // window has had at most a step or two of use, so it counts as unused.
  const window = (
    used: [EpochMs, number],
    reset: [EpochMs, number] | undefined,
    lengthMs: number,
    /** A countdown of zero or less: a weekly one is not known, a 5-hour one reset when read. */
    zero: 'unknown' | 'read',
  ): QuotaWindow => {
    const resetsAt =
      reset === undefined || (reset[1] <= 0 && zero === 'unknown')
        ? null
        : reset[0] + Math.max(0, reset[1]) * 1000
    const begunSince = resetsAt !== null && resetsAt - lengthMs > used[0] - stepMs
    return { usedFraction: begunSince ? 0 : used[1], resetsAt, lengthMs }
  }
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
      weekly: window(used, weeklyReset, WEEK_MS, 'unknown'),
      fiveHour: five === undefined ? null : window(five, fiveReset, FIVE_HOURS_MS, 'read'),
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    })
  }
  return profiles.sort((a, b) => a.profile.localeCompare(b.profile))
}

/**
 * Waste and clipping in one forecast from `at` to its horizon: what its weekly resets from then on
 * throw away, and the demand its gaps leave unserved from then on (gap hours times the weekly
 * pace). At the forecast's own clock, the whole week ahead; later, what is still to come.
 */
export function wasteAndClipping(
  gaps: PoolGaps,
  at: EpochMs = gaps.clock,
  /** The pace the forecast ran at moment by moment, when it was not one pace throughout. */
  paceAt?: (t: EpochMs) => PoolGaps['pace'],
): HindcastPoint {
  const end = gaps.clock + GAPS_HORIZON_MS
  let gapMs = 0
  let clipped = 0
  for (const g of gaps.gaps) {
    const from = Math.max(g.start, at)
    const to = Math.min(g.end ?? end, end)
    if (to <= from) continue
    gapMs += to - from
    if (paceAt === undefined) continue
    // The demand turned away, step by step through the gap.
    for (let t = from; t < to; t += PACE_STEP_MS) {
      clipped += (paceAt(t).weekly * (Math.min(t + PACE_STEP_MS, to) - t)) / HOUR_MS
    }
  }
  const clippedHours = gapMs / HOUR_MS
  return {
    at,
    wasted: gaps.unusedAtReset.reduce((sum, r) => (r.at >= at ? sum + r.unused : sum), 0),
    clipped: paceAt === undefined ? clippedHours * gaps.pace.weekly : clipped,
    clippedHours,
  }
}

/** How finely a pace that changes is summed through a gap. */
const PACE_STEP_MS = 10 * 60_000

/**
 * Last week's pace, hour by hour: at any moment, what the pool used of its weekly limits in the
 * same hour a week before (each subscription's rise in that hour, a reset's fall counted as new
 * use), and the 5-hour pace that makes through what a full 5-hour window costs of the week. An
 * hour with no readings used nothing. Hours the pool was out used less than was asked of it.
 */
export function weekAgoPace(
  weeklyUsed: Series[],
  weekPerWindow: number | null,
): (t: EpochMs) => PoolGaps['pace'] {
  const byHour = new Map<EpochMs, number>()
  const hour = (t: EpochMs) => Math.floor(t / HOUR_MS) * HOUR_MS
  const hours = new Set<EpochMs>()
  for (const s of weeklyUsed) for (const [t] of s.points) hours.add(hour(t))
  for (const h of hours) {
    let rise = 0
    for (const s of weeklyUsed) rise += riseOver(s.points, h + HOUR_MS, HOUR_MS, 0)?.rise ?? 0
    byHour.set(h, rise)
  }
  return (t) => {
    const weekly = byHour.get(hour(t - WEEK_MS)) ?? 0
    return {
      weekly,
      fiveHour: weekPerWindow !== null && weekPerWindow > 0 ? weekly / weekPerWindow : 0,
    }
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
    return wasteAndClipping(poolGaps(profiles, t, smoothed, t, false, pace))
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

/** A weekly reset and the share of that subscription's week it threw away. */
export interface ResetWaste {
  profile: string
  at: EpochMs
  unused: number
}

/** How far before a reset the last used share is looked for. */
const BEFORE_RESET_MS = 30 * 60_000

/**
 * The weekly resets in [from, to) and what each threw away, measured from the readings: a reset
 * is where a subscription's countdown names a week at least a day later than the one before
 * while that one's reset has come, and what it threw away is what the highest used share in the
 * half hour before it left (a bucket holding the reset has the old week's share as its highest).
 * A reset with no reading of the share before it is left out.
 */
export function measuredResets(
  history: Pick<QuotaHistory, 'stepMs' | 'weeklyUsed' | 'weeklyResetsInSeconds'>,
  from: EpochMs,
  to: EpochMs,
): ResetWaste[] {
  const used = new Map(history.weeklyUsed.map((s) => [s.key, s.points]))
  const resets: ResetWaste[] = []
  for (const s of history.weeklyResetsInSeconds) {
    const points = s.points.filter(([, v]) => Number.isFinite(v) && v > 0)
    for (let i = 1; i < points.length; i++) {
      const [aAt, aLeft] = points[i - 1] as [EpochMs, number]
      const [bAt, bLeft] = points[i] as [EpochMs, number]
      const reset = aAt + aLeft * 1000
      const next = bAt + bLeft * 1000
      if (next - reset < 24 * HOUR_MS || reset > bAt + history.stepMs) continue
      if (reset < from || reset >= to) continue
      let before = Number.NEGATIVE_INFINITY
      for (const [t, v] of used.get(s.key) ?? []) {
        if (t > reset - BEFORE_RESET_MS && t <= reset && Number.isFinite(v))
          before = Math.max(before, v)
      }
      if (before === Number.NEGATIVE_INFINITY) continue
      resets.push({ profile: s.key, at: reset, unused: Math.max(0, 1 - before) })
    }
  }
  return resets.sort((a, b) => a.at - b.at)
}

/** How wide a reset's spike is drawn: a minute either side, a line at any chart's width. */
const SPIKE_MS = 60_000

/**
 * Waste as it happens: nothing at each of `times`, and at each reset a spike to what it threw
 * away (resets at the same moment add up). A time within a spike's width of a reset gives way.
 */
export function resetSpikes(
  resets: ReadonlyArray<{ at: EpochMs; unused: number }>,
  times: EpochMs[],
): Array<[EpochMs, number]> {
  const at = new Map<EpochMs, number>()
  for (const r of resets) at.set(r.at, (at.get(r.at) ?? 0) + r.unused)
  const near = (t: EpochMs) => [...at.keys()].some((r) => Math.abs(t - r) <= SPIKE_MS)
  const points: Array<[EpochMs, number]> = times.filter((t) => !near(t)).map((t) => [t, 0])
  for (const [t, unused] of at) {
    points.push([t - SPIKE_MS, 0], [t, unused], [t + SPIKE_MS, 0])
  }
  return points.sort((a, b) => a[0] - b[0])
}
