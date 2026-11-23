import { type PoolGaps, riseOver } from './forecast'
import { type EpochMs, HOUR_MS, type Series } from './types'

// Last week from the quota readings: what weekly resets threw away, when no subscription could
// take work, and the pool's use hour by hour to replay it.

/**
 * The quota readings last week is measured from, per subscription, on one step grid: each point
 * is its bucket's start and the highest reading in it (MAX), as CloudWatch returns them.
 */
export interface QuotaHistory {
  stepMs: number
  weeklyUsed: Series[]
  weeklyResetsInSeconds: Series[]
  fiveHourUsed: Series[]
}

/** How far back last week is read: a week, before the two days its pace is measured over. */
export const HISTORY_SPAN_MS = 7 * 24 * HOUR_MS

/** The spans of readings a forecast can replay: the last day's, or the last week's. */
export const DAY_MS = 24 * HOUR_MS

/**
 * The pool's use over the last `periodMs` of whole hours before `end`, replayed hour by hour and
 * over again: at any moment, what the pool used of its weekly limits in the same hour one period,
 * or as many as reach back into those hours, before (each subscription's rise in that hour, a
 * reset's fall counted as new use), and the 5-hour pace that makes through what a full 5-hour
 * window costs of the week. The hour `end` falls in is still being read, so it is left out. An
 * hour with no readings used nothing. Hours the pool was out used less than was asked of it.
 */
export function replayedPace(
  weeklyUsed: Series[],
  weekPerWindow: number | null,
  end: EpochMs,
  periodMs: number,
): (t: EpochMs) => PoolGaps['pace'] {
  const hour = (t: EpochMs) => Math.floor(t / HOUR_MS) * HOUR_MS
  const start = hour(end) - periodMs
  const byHour = new Map<EpochMs, number>()
  for (let h = start; h < start + periodMs; h += HOUR_MS) {
    let rise = 0
    for (const s of weeklyUsed) rise += riseOver(s.points, h + HOUR_MS, HOUR_MS, 0)?.rise ?? 0
    byHour.set(h, rise)
  }
  return (t) => {
    const offset = (((hour(t) - start) % periodMs) + periodMs) % periodMs
    const weekly = byHour.get(start + offset) ?? 0
    return {
      weekly,
      fiveHour: weekPerWindow !== null && weekPerWindow > 0 ? weekly / weekPerWindow : 0,
    }
  }
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
 * buckets starting in the half hour before it left (a bucket holding the reset has the old week's
 * share as its highest; one starting at or after it, the new week's).
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
        // A bucket that starts at or after the reset holds the new week only.
        if (t > reset - BEFORE_RESET_MS && t < reset && Number.isFinite(v))
          before = Math.max(before, v)
      }
      if (before === Number.NEGATIVE_INFINITY) continue
      resets.push({ profile: s.key, at: reset, unused: Math.max(0, 1 - before) })
    }
  }
  return resets.sort((a, b) => a.at - b.at)
}

/**
 * What a full 5-hour window costs of the week, for replaying last week: the pool's own over the
 * last two days (weekPerFiveHourWindow), else the one the forecast now runs at (its weekly pace
 * over its 5-hour one); null when neither tells, and then last week cannot be replayed, since
 * its 5-hour use would be taken as none.
 */
export function replayWeekPerWindow(
  measured: number | null,
  pace: PoolGaps['pace'] | null,
): number | null {
  if (measured !== null && Number.isFinite(measured) && measured > 0) return measured
  if (pace === null || !(pace.fiveHour > 0) || !(pace.weekly > 0)) return null
  return pace.weekly / pace.fiveHour
}

/** A share this close to full is full: what the poll reports for a window that is used up. */
const FULL_READING = 1 - 1e-9

/** How long a reading stands for its subscription when the next is missing (a few missed polls). */
const READING_HOLDS_MS = 30 * 60_000

/**
 * The reading that stands at `t`: the latest at or before it, if under READING_HOLDS_MS old, of
 * points in time order.
 */
function readingAt(points: Array<[EpochMs, number]>, t: EpochMs): number | undefined {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((points[mid]?.[0] ?? 0) <= t) lo = mid + 1
    else hi = mid
  }
  const p = points[lo - 1]
  return p === undefined || t - p[0] >= READING_HOLDS_MS || !Number.isFinite(p[1])
    ? undefined
    : p[1]
}

/**
 * When the pool had no tokens in [from, to), measured from the readings. A reading stands for its
 * subscription from its time until the next, for under READING_HOLDS_MS (a missing reading does
 * not take a subscription out of the pool, and an old one does not stand for ever). At any moment
 * the pool is out when at least one subscription has a standing weekly reading and every such one
 * is out of its week or of its 5-hour window. That only changes when a reading starts or stops
 * standing, so the state is worked out at exactly those moments (and at `from`, from the readings
 * before it) and held between them. A reading is its step's highest, so a window that reset
 * within the step counts that step as out.
 */
export function measuredBlocked(
  history: Pick<QuotaHistory, 'stepMs' | 'weeklyUsed' | 'fiveHourUsed'>,
  from: EpochMs,
  to: EpochMs,
): Array<{ start: EpochMs; end: EpochMs }> {
  const five = new Map(history.fiveHourUsed.map((s) => [s.key, s.points]))
  const changes = new Set<EpochMs>([from])
  for (const s of [...history.weeklyUsed, ...history.fiveHourUsed]) {
    for (const [t] of s.points) {
      for (const at of [t, t + READING_HOLDS_MS]) if (at > from && at < to) changes.add(at)
    }
  }
  const outAt = (t: EpochMs) => {
    let read = false
    for (const s of history.weeklyUsed) {
      const week = readingAt(s.points, t)
      if (week === undefined) continue
      read = true
      const window = readingAt(five.get(s.key) ?? [], t)
      if (week < FULL_READING && (window === undefined || window < FULL_READING)) return false
    }
    return read
  }
  const times = [...changes].sort((a, b) => a - b)
  const spans: Array<{ start: EpochMs; end: EpochMs }> = []
  for (const [i, t] of times.entries()) {
    if (!outAt(t)) continue
    const end = times[i + 1] ?? to
    const last = spans.at(-1)
    if (last !== undefined && last.end === t) last.end = end
    else spans.push({ start: t, end })
  }
  return spans
}

/** What the resets threw away from the start of `times` to each of them: a running total. */
export function runningWaste(
  resets: ReadonlyArray<{ at: EpochMs; unused: number }>,
  times: EpochMs[],
): Array<[EpochMs, number]> {
  const start = times[0] ?? 0
  const sorted = resets.filter((r) => r.at >= start).sort((a, b) => a.at - b.at)
  let i = 0
  let total = 0
  return times.map((t) => {
    for (; i < sorted.length && (sorted[i]?.at ?? 0) <= t; i++) total += sorted[i]?.unused ?? 0
    return [t, total]
  })
}

/** Hours without tokens from the start of `times` to each of them: a running total. */
export function runningBlocked(
  spans: ReadonlyArray<{ start: EpochMs; end: EpochMs }>,
  times: EpochMs[],
): Array<[EpochMs, number]> {
  const start = times[0] ?? 0
  return times.map((t) => {
    let ms = 0
    for (const s of spans) ms += Math.max(0, Math.min(s.end, t) - Math.max(s.start, start))
    return [t, ms / HOUR_MS]
  })
}

/** When Anthropic reset a subscription's week, or its Fable allowance alone, before it was due. */
export interface EarlyResets {
  weekly: EpochMs[]
  fable: EpochMs[]
}

/** How far a used share must fall from one bucket to the next to be a reset, not a correction. */
const EARLY_RESET_DROP = 0.1

/**
 * How much of the higher reading the lower one may keep and still be a reset: a reset starts the
 * allowance from nothing, so what is left is only what was used since. A fall that keeps more (a
 * poll's correction, a raised limit) is not one.
 */
const EARLY_RESET_KEEPS = 0.25

/**
 * How long after a week's early reset a Fable fall is still that reset: the server learns the two
 * from different readings (any response or poll for the week, a poll or a Fable response for
 * Fable), a few polls apart at most.
 */
const SAME_RESET_MS = 30 * 60_000

/** How old the countdown read before a fall may be to say when the reset was due. */
const COUNTDOWN_MAX_AGE_MS = HOUR_MS

/**
 * The resets in [from, to) that came early: where the used share falls by at least a tenth from one
 * bucket to the next while the reset due, by the countdown read before the higher bucket, was not
 * until after the lower bucket ended, and the lower reading keeps at most a quarter of the higher
 * (a reset starts from nothing). The countdown is taken from before the higher bucket because a
 * bucket holding an ordinary reset already reads the next week's countdown as its highest. Each is
 * placed at the lower bucket's start: the first bucket whose highest reading is the new allowance's
 * (the reset itself fell within the bucket before).
 */
export function earlyResetTimes(
  used: ReadonlyArray<[EpochMs, number]>,
  resetsIn: ReadonlyArray<[EpochMs, number]>,
  stepMs: number,
  from: EpochMs,
  to: EpochMs,
): EpochMs[] {
  const readings = used.filter(([, v]) => Number.isFinite(v))
  const countdowns = resetsIn.filter(([, v]) => Number.isFinite(v) && v > 0)
  const resets: EpochMs[] = []
  for (let i = 1; i < readings.length; i++) {
    const [highAt, high] = readings[i - 1] as [EpochMs, number]
    const [lowAt, low] = readings[i] as [EpochMs, number]
    if (lowAt < from || lowAt >= to || high - low < EARLY_RESET_DROP) continue
    if (low > high * EARLY_RESET_KEEPS) continue
    // Neighbouring buckets only: across a gap in the readings nothing says when it fell.
    if (lowAt - highAt > stepMs) continue
    let due: EpochMs | null = null
    for (const [t, left] of countdowns) {
      if (t >= highAt) break
      if (t >= highAt - COUNTDOWN_MAX_AGE_MS) due = t + left * 1000
    }
    if (due !== null && due > lowAt + stepMs) resets.push(lowAt)
  }
  return resets
}

/**
 * Each subscription's early resets in [from, to) (earlyResetTimes): of its week, and of its Fable
 * allowance on its own. A Fable fall from a bucket before an early weekly reset to half an hour after
 * it is that reset, not a second one.
 */
export function earlyResets(
  history: {
    stepMs: number
    weeklyUsed: Series[]
    weeklyResetsInSeconds: Series[]
    fableUsed: Series[]
    fableResetsInSeconds: Series[]
  },
  from: EpochMs,
  to: EpochMs,
): Map<string, EarlyResets> {
  const points = (series: Series[]) => new Map(series.map((s) => [s.key, s.points]))
  const weeklyCountdown = points(history.weeklyResetsInSeconds)
  const fableUsed = points(history.fableUsed)
  const fableCountdown = points(history.fableResetsInSeconds)
  const profiles = new Set([...history.weeklyUsed, ...history.fableUsed].map((s) => s.key))
  const weeklyUsed = points(history.weeklyUsed)
  const out = new Map<string, EarlyResets>()
  for (const profile of profiles) {
    const weekly = earlyResetTimes(
      weeklyUsed.get(profile) ?? [],
      weeklyCountdown.get(profile) ?? [],
      history.stepMs,
      from,
      to,
    )
    const fable = earlyResetTimes(
      fableUsed.get(profile) ?? [],
      fableCountdown.get(profile) ?? [],
      history.stepMs,
      from,
      to,
    ).filter((t) => !weekly.some((w) => t >= w - history.stepMs && t <= w + SAME_RESET_MS))
    if (weekly.length > 0 || fable.length > 0) out.set(profile, { weekly, fable })
  }
  return out
}
