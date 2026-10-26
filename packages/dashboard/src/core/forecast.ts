import { formatCountdown } from './format'
import { elapsedFraction } from './pace'
import { type EpochMs, FIVE_HOURS_MS, HOUR_MS, type ProfileStatus, type QuotaWindow } from './types'

/** Which allowance a forecast is about. */
export type WindowKind = 'weekly' | 'fiveHour'

/** How far ahead each forecast looks: past this, the pool is reported as lasting. */
export const FORECAST_HORIZON_MS: Record<WindowKind, number> = {
  weekly: 7 * 24 * HOUR_MS,
  fiveHour: 24 * HOUR_MS,
}

const STEP_MS: Record<WindowKind, number> = {
  weekly: 10 * 60_000,
  fiveHour: 2 * 60_000,
}

/** The span a smoothed weekly burn rate is measured over: a whole day, so night and day average out. */
export const WEEKLY_SMOOTHING_MS = 24 * HOUR_MS

/** Readings must cover at least this long for a smoothed rate; two close readings say little. */
export const MIN_SMOOTHING_COVERAGE_MS = HOUR_MS

/** A window that has run less than this is measured as if it had run this long. */
export const MIN_AVERAGE_ELAPSED_MS = 30 * 60_000

/** A reading below this share of the highest one before it is a reset, not a dip. */
const RESET_FALL = 0.5

/**
 * A subscription's smoothed burn rate, in shares of its allowance per hour, from readings of its
 * used share within the span: how much the share rose, over the time the readings cover.
 * Readings are sorted and a time read twice keeps its highest value. A fall below half the
 * highest reading so far is a reset, and the new reading counts as use since it; a smaller dip
 * adds nothing until the share passes its earlier high again. Null when the readings cover less
 * than MIN_SMOOTHING_COVERAGE_MS.
 */
export function burnRate(
  points: Array<[EpochMs, number]>,
  now: EpochMs,
  spanMs: number,
): number | null {
  const r = riseOver(points, now, spanMs)
  return r === null ? null : (r.rise / r.coveredMs) * HOUR_MS
}

/**
 * How much a used share rose over the span ending at `now`, counting a reset's fall as the start of
 * new use (as burnRate), and the time from its first reading there to its last; null without
 * readings covering `minCoveredMs` of it.
 */
export function riseOver(
  points: Array<[EpochMs, number]>,
  now: EpochMs,
  spanMs: number,
  minCoveredMs: number = MIN_SMOOTHING_COVERAGE_MS,
): { rise: number; coveredMs: number; first: EpochMs; last: EpochMs } | null {
  const byTime = new Map<EpochMs, number>()
  for (const [t, v] of points) {
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < now - spanMs || t > now) continue
    byTime.set(t, Math.max(byTime.get(t) ?? Number.NEGATIVE_INFINITY, v))
  }
  const readings = [...byTime.entries()].sort((x, y) => x[0] - y[0])
  const first = readings[0]
  const last = readings[readings.length - 1]
  if (first === undefined || last === undefined) return null
  const covered = last[0] - first[0]
  if (covered < minCoveredMs) return null
  let rise = 0
  let peak = first[1]
  for (const [, v] of readings.slice(1)) {
    if (v < peak * RESET_FALL) {
      rise += Math.max(0, v)
      peak = v
    } else if (v > peak) {
      rise += v - peak
      peak = v
    }
  }
  return { rise, coveredMs: covered, first: first[0], last: last[0] }
}

/** The span over which what a full 5-hour window costs of the week is measured. */
export const WEEK_PER_WINDOW_SPAN_MS = 48 * HOUR_MS

/** Below this many full 5-hour windows of use in the span, the cost is not measured. */
const MIN_WINDOWS_MEASURED = 0.5

type Readings = ReadonlyArray<{ key: string; points: Array<[EpochMs, number]> }>

/**
 * The pool's weekly burn rate, in one subscription's allowance per hour: every subscription's rise
 * over the span, over the longest time any of them covers. Not the sum of each one's own rate: one
 * that joined an hour ago took work the others would have, and its rise over that hour alone would
 * count the pool's demand twice. Every rise counts, however short its readings; the pool's must
 * cover MIN_SMOOTHING_COVERAGE_MS, else null.
 */
export function poolBurnRate(weekly: Readings, now: EpochMs, spanMs: number): number | null {
  let rise = 0
  let covered = 0
  for (const s of weekly) {
    const r = riseOver(s.points, now, spanMs, 0)
    if (r === null) continue
    rise += r.rise
    covered = Math.max(covered, r.coveredMs)
  }
  return covered < MIN_SMOOTHING_COVERAGE_MS ? null : (rise / covered) * HOUR_MS
}

/**
 * What a full 5-hour window costs of the week, from the pool's own readings: the weekly rise over
 * the 5-hour rise, summed over the subscriptions read in both, over the last
 * WEEK_PER_WINDOW_SPAN_MS. Each subscription's two rises are taken over the same time, the part
 * of the span both windows' readings cover, so a gap in one does not skew the cost. The same work spends both windows, so this ties the two paces together
 * (0.25 to 0.29 from 2026-10-12 to 10-19). Null with too little 5-hour use to tell.
 */
export function weekPerFiveHourWindow(
  weekly: Readings,
  fiveHour: Readings,
  now: EpochMs,
): number | null {
  const fiveByKey = new Map(fiveHour.map((s) => [s.key, s.points]))
  let weekRise = 0
  let fiveRise = 0
  for (const s of weekly) {
    const five = fiveByKey.get(s.key)
    if (five === undefined) continue
    const shared = sharedRises(s.points, five, now, WEEK_PER_WINDOW_SPAN_MS)
    if (shared === null) continue
    weekRise += shared[0]
    fiveRise += shared[1]
  }
  if (fiveRise < MIN_WINDOWS_MEASURED || weekRise <= 0) return null
  return weekRise / fiveRise
}

/**
 * Two series' rises over the same time: from the later of their first readings in the span to the
 * earlier of their last, narrowed until both have a reading at each end (a missing bucket in one
 * would otherwise leave it measured over less time). Null when they share under an hour.
 */
function sharedRises(
  a: Array<[EpochMs, number]>,
  b: Array<[EpochMs, number]>,
  now: EpochMs,
  spanMs: number,
): [number, number] | null {
  let start = now - spanMs
  let end = now
  for (;;) {
    const ra = riseOver(a, end, end - start)
    const rb = riseOver(b, end, end - start)
    if (ra === null || rb === null) return null
    const first = Math.max(ra.first, rb.first)
    const last = Math.min(ra.last, rb.last)
    if (first === ra.first && first === rb.first && last === ra.last && last === rb.last) {
      return [ra.rise, rb.rise]
    }
    // Each pass moves an end to a reading inside the last bounds, so this ends.
    start = first
    end = last
  }
}

/** The pool's demand as measured from both windows' readings; null where they cannot tell. */
export interface PoolRates {
  /** poolBurnRate over WEEKLY_SMOOTHING_MS. */
  weekly: number | null
  /** weekPerFiveHourWindow. */
  weekPerWindow: number | null
}

export function poolRates(weekly: Readings, fiveHour: Readings, now: EpochMs): PoolRates {
  return {
    weekly: poolBurnRate(weekly, now, WEEKLY_SMOOTHING_MS),
    weekPerWindow: weekPerFiveHourWindow(weekly, fiveHour, now),
  }
}

/**
 * The pool's pace as one demand: the weekly pace is the pool's use over the last day (current use
 * leads the projection), and the 5-hour pace is what that same work makes of a 5-hour window,
 * through what a full one costs of the week. Where the readings cannot tell, the pace measured
 * from the subscriptions (`measured`, poolGaps' own) stays.
 */
export function poolPace(
  measured: { weekly: number; fiveHour: number },
  rates: PoolRates,
): { weekly: number; fiveHour: number } {
  const weekly =
    rates.weekly !== null && Number.isFinite(rates.weekly) ? rates.weekly : measured.weekly
  const ratio = rates.weekPerWindow
  const fiveHour =
    ratio !== null && ratio > 0 && Number.isFinite(ratio) ? weekly / ratio : measured.fiveHour
  return { weekly, fiveHour }
}

/**
 * The average burn rate since the window began (shares per hour), as of `at`, the time of the
 * reading; a window younger than MIN_AVERAGE_ELAPSED_MS counts as that old, so a little use in
 * its first minutes does not read as a stampede. Null when unknown.
 */
export function averageBurnRate(window: QuotaWindow, at: EpochMs): number | null {
  const elapsed = elapsedFraction(window, at)
  const used = window.usedFraction
  if (elapsed === null || used === null || !Number.isFinite(used)) return null
  const elapsedMs = Math.max(elapsed * window.lengthMs, MIN_AVERAGE_ELAPSED_MS)
  return (Math.min(1, Math.max(0, used)) / elapsedMs) * HOUR_MS
}

export interface PoolForecast {
  window: WindowKind
  /** Subscriptions with a reading of this window. */
  counted: number
  /** Subscriptions without one, which the forecast leaves out. */
  unreported: number
  /** The mean used share of those counted, 0 to 1; null with none. */
  used: number | null
  /** The pool's demand, in one subscription's allowance per hour. */
  burnPerHour: number
  /** How many counted subscriptions have a smoothed rate; the rest use their average. */
  smoothedCount: number
  /**
   * When claude-master can pick none of the counted subscriptions (this window or its week is
   * full for each); `from` when that is already so.
   */
  clipsAt: EpochMs | null
  /** When the first of them can be picked again, so work flows; null when unknown. */
  recoversAt: EpochMs | null
  /**
   * Why there is no clip time: demand is nil, nothing runs out within the horizon, no
   * subscription reports this window, or every one that does has an expired login.
   */
  lasts: 'idle' | 'horizon' | 'unknown' | 'logins' | null
}

/** One window of one subscription as the simulation moves it along. */
export interface SimWindow {
  used: number
  resetsAt: EpochMs | null
  lengthMs: number
  /** Whether the used share was read; claude-master ranks an unread week after every read one. */
  known: boolean
}

/**
 * A subscription in the simulation: the window being forecast, and its weekly window, which is
 * what claude-master routes by (the same object when the weekly window is the one forecast).
 */
export interface Slot {
  quota: SimWindow
  weekly: SimWindow
  /** Its place in the snapshot, claude-master's last tiebreak (the configured order). */
  index: number
}

/** Above this used share a weekly allowance is in claude-master's reserve tier. */
export const WEEKLY_RESERVE_FROM = 0.9

function simWindow(w: QuotaWindow | null): SimWindow {
  const lengthMs = w !== null && Number.isFinite(w.lengthMs) && w.lengthMs > 0 ? w.lengthMs : null
  const used = w?.usedFraction
  return {
    used:
      used === null || used === undefined || !Number.isFinite(used)
        ? 0
        : Math.min(1, Math.max(0, used)),
    resetsAt:
      lengthMs !== null && w?.resetsAt != null && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
    lengthMs: lengthMs ?? 1,
    known: used !== null && used !== undefined && Number.isFinite(used),
  }
}

// Moves a window past every reset up to `t` in one step (a loop of single windows could run for
// ever on a reset time far in the past).
function catchUp(w: SimWindow, t: EpochMs): void {
  if (w.resetsAt === null || w.resetsAt > t) return
  const windows = Math.floor((t - w.resetsAt) / w.lengthMs) + 1
  w.resetsAt += windows * w.lengthMs
  w.used = 0
  // Past float precision the reset time cannot move; it is unknown from here.
  if (!(w.resetsAt > t)) w.resetsAt = null
}

/** Whether claude-master can pick the subscription: room in the forecast window and the week. */
const routable = (s: Slot) => s.quota.used < 1 && s.weekly.used < 1

/**
 * claude-master's order (backendQuotaBefore), from the state at this step: outside the weekly
 * reserve tier first, then a read week before an unread one, then the soonest weekly reset
 * (unknown last), then the configured order.
 */
export function routeOrder(x: Slot, y: Slot): number {
  const reserve = (s: Slot) => Number(s.weekly.used >= WEEKLY_RESERVE_FROM)
  const unread = (s: Slot) => Number(!s.weekly.known)
  const reset = (s: Slot) => s.weekly.resetsAt ?? Number.POSITIVE_INFINITY
  return (
    reserve(x) - reserve(y) ||
    unread(x) - unread(y) ||
    // Equal resets (both unknown among them) leave the configured order to decide.
    (reset(x) === reset(y) ? 0 : reset(x) - reset(y)) ||
    x.index - y.index
  )
}

/** When a subscription can be picked again: after whichever full window resets last. */
function availableAt(s: Slot, t: EpochMs): EpochMs | null {
  let at = t
  for (const w of [s.quota, s.weekly]) {
    if (w.used < 1) continue
    if (w.resetsAt === null) return null
    at = Math.max(at, w.resetsAt)
  }
  return at
}

const reading = (p: ProfileStatus, window: WindowKind): QuotaWindow | null => {
  const w = window === 'weekly' ? p.weekly : p.fiveHour
  return w === null || w.usedFraction === null || !Number.isFinite(w.usedFraction) ? null : w
}

/**
 * When the whole pool runs out of one window: every subscription's allowance of it used up at
 * once, so requests go to the paid backup or fail. It starts at `from`, the time of the
 * readings (the snapshot's asOf).
 *
 * Demand is the sum of the subscriptions' burn rates (the smoothed one when given, else the
 * average since the window began), measured in one subscription's allowance per hour, so it
 * assumes the subscriptions are the same size. Going forward the demand goes where
 * claude-master routes it, judged at every step: subscriptions with room in this window and
 * their week only, those under the weekly reserve tier first, then the soonest weekly reset,
 * then the configured order. The 5-hour forecast moves each weekly window to its resets but
 * keeps its used share (the 5-hour use is not converted to weekly use). A subscription takes
 * work again when its windows reset, and a 5-hour window is taken to restart at once. A run-out
 * that has ended by `now` is skipped. A subscription whose login has expired adds no room; one with no reading of the
 * window is left out (`unreported`). Steps are STEP_MS apart, so a pool that runs out less than
 * a step before a reset may show no clip.
 */
export function poolForecast(
  profiles: ProfileStatus[],
  window: WindowKind,
  from: EpochMs,
  smoothed: ReadonlyMap<string, number | null> = new Map(),
  now: EpochMs = from,
): PoolForecast {
  const slots: Slot[] = []
  let demand = 0
  let usedSum = 0
  let counted = 0
  let smoothedCount = 0
  for (const [index, p] of profiles.entries()) {
    const w = reading(p, window)
    if (w === null) continue
    counted++
    const quota = simWindow(w)
    const slot: Slot = {
      quota,
      weekly: window === 'weekly' ? quota : simWindow(p.weekly),
      index,
    }
    // A reading from before its window reset: that window is over and nothing of the new one
    // is known to be used.
    catchUp(slot.quota, from)
    usedSum += slot.quota.used
    const smooth = smoothed.get(p.profile)
    const hasSmooth = smooth !== null && smooth !== undefined && Number.isFinite(smooth)
    if (hasSmooth) smoothedCount++
    const rate = hasSmooth ? smooth : (averageBurnRate(w, from) ?? 0)
    demand += Number.isFinite(rate) ? Math.max(0, rate) : 0
    const loginExpired = p.tokenExpiresAt !== null && p.tokenExpiresAt <= from
    if (!loginExpired) slots.push(slot)
  }
  const base = {
    window,
    counted,
    unreported: profiles.length - counted,
    used: counted === 0 ? null : usedSum / counted,
    burnPerHour: demand,
    smoothedCount,
  }
  const lasting = (lasts: PoolForecast['lasts']): PoolForecast => ({
    ...base,
    clipsAt: null,
    recoversAt: null,
    lasts,
  })
  if (counted === 0) return lasting('unknown')
  if (slots.length === 0) return lasting('logins')

  const step = STEP_MS[window]
  const perStep = (demand / HOUR_MS) * step
  const end = from + FORECAST_HORIZON_MS[window]
  for (let t = from; t <= end; t += step) {
    for (const s of slots) {
      catchUp(s.quota, t)
      if (s.weekly !== s.quota) catchUp(s.weekly, t)
    }
    const open = slots.filter(routable)
    if (open.length === 0) {
      const resets = slots.map((s) => availableAt(s, t)).filter((r): r is EpochMs => r !== null)
      const recoversAt = resets.length === 0 ? null : Math.min(...resets)
      // A run-out that has already ended by `now` (the readings lag the clock) is not reported;
      // the simulation goes on from the reset.
      if (recoversAt === null || recoversAt > now) {
        return { ...base, clipsAt: t, recoversAt, lasts: null }
      }
      continue
    }
    if (perStep <= 0) break
    // In claude-master's order as of this step; what one cannot take goes to the next.
    open.sort(routeOrder)
    let left = perStep
    for (const s of open) {
      if (left <= 0) break
      const take = Math.min(left, 1 - s.quota.used)
      s.quota.used += take
      left -= take
    }
  }
  return lasting(demand <= 0 ? 'idle' : 'horizon')
}

/** A time when no subscription can take work. */
export interface PoolGap {
  start: EpochMs
  /** When the first subscription can take work again; null when no reset time is known. */
  end: EpochMs | null
  /**
   * What ends it: a window's reset (the weekly one on a tie), or the end of a rate limit
   * Anthropic set; null when no reset time is known.
   */
  endsWith: WindowKind | 'rateLimit' | null
}

/** The pool's gaps from one simulation of both windows together. */
export interface PoolGaps {
  /** Subscriptions with a weekly reading; the others are left out. */
  counted: number
  unreported: number
  /** The gaps in the horizon, in order, that have not ended by `now`. */
  gaps: PoolGap[]
  /**
   * The capacity left at this pace, every TRACE_STEP_MS from the readings to the horizon: the
   * sum over the subscriptions that can work of what is left of each window, in one
   * subscription's allowance (five unused subscriptions are 5). A 5-hour window counts only
   * while its week has room, since one in a used-up week cannot be used.
   */
  trace: CapacityPoint[]
  /** The forecast's clock (`now`): the trace has a point there, besides its 10-minute grid. */
  clock: EpochMs
  /** The most the trace can show: one for each subscription that can work (login valid). */
  capacity: number
  /** The subscriptions the trace covers, in order (those that can work). */
  subscriptions: string[]
  /**
   * The pace the forecast assumes, in one subscription's allowance per hour: of a weekly limit
   * (the last day's average) and of a 5-hour limit (each open window's average so far).
   */
  pace: { weekly: number; fiveHour: number }
  /**
   * What each weekly reset after now throws away at this pace: the share of that subscription's
   * week still unused when it resets (one subscription's limit is 1). Tokens left on the table.
   */
  unusedAtReset: Array<{ profile: string; at: EpochMs; unused: number }>
  /** Why there is no gap, as PoolForecast's `lasts`; null when there is one. */
  lasts: PoolForecast['lasts']
}

/** What is left of each window across the pool at one moment (see PoolGaps.trace). */
export interface CapacityPoint {
  at: EpochMs
  weekly: number
  fiveHour: number
  /** What is left of each subscription's week, in PoolGaps.subscriptions' order. */
  weeklyBy: number[]
  /** What each subscription's 5-hour window can still take, in the same order (see fiveHour). */
  fiveHourBy: number[]
  /** When each subscription's week resets next, in the same order; null when unknown. */
  weeklyResetsBy: Array<EpochMs | null>
}

/** How often the capacity trace is sampled. */
export const TRACE_STEP_MS = 10 * 60_000

/** How far ahead the gaps are looked for, and how finely. */
export const GAPS_HORIZON_MS = 7 * 24 * HOUR_MS
// As fine as the 5-hour card's, so a gap it shows is not stepped over here.
const GAPS_STEP_MS = STEP_MS.fiveHour

interface JointSlot extends Slot {
  /**
   * The 5-hour window. A 5-hour window opens with the first request after the last one closed:
   * here one with no reset time and nothing used (not read, or no window open) is closed, opens
   * when the subscription next takes work, and closes again at its reset.
   */
  five: SimWindow
  /** Until when Anthropic is rate-limiting it (a 429), so it takes no work; null when not. */
  limitedUntil: EpochMs | null
}

/** Closes a 5-hour window whose reset has passed: the next work opens a new one. */
function closeIfOver(w: SimWindow, t: EpochMs): void {
  if (w.resetsAt === null || w.resetsAt > t) return
  w.used = 0
  w.resetsAt = null
}

// A share that floating-point sums leave a hair under full is full.
const FULL = 1 - 1e-9
const isFull = (w: SimWindow) => w.used >= FULL

/**
 * When the subscription can be picked again, after whichever of its full windows resets last,
 * and which window that is (the weekly one on a tie); null when a full window has no reset time.
 */
function availableAfter(
  s: JointSlot,
  t: EpochMs,
): { at: EpochMs; window: WindowKind | 'rateLimit' } | null {
  let at = t
  let window: WindowKind | 'rateLimit' = 'weekly'
  const full: Array<[SimWindow, WindowKind]> = [
    [s.weekly, 'weekly'],
    [s.five, 'fiveHour'],
  ]
  for (const [w, kind] of full) {
    if (!isFull(w)) continue
    if (w.resetsAt === null) return null
    if (w.resetsAt > at || (w.resetsAt === at && kind === 'weekly')) {
      at = w.resetsAt
      window = kind
    }
  }
  if (s.limitedUntil !== null && s.limitedUntil > at) {
    at = s.limitedUntil
    window = 'rateLimit'
  }
  return { at, window }
}

/**
 * When no subscription can take work, from one simulation of both windows: the weekly forecast
 * alone does not see 5-hour gaps, and the 5-hour one alone does not use up any week, so neither
 * can say when work stops.
 *
 * As poolForecast, from `from` (the readings' time) in claude-master's routing order, with the
 * pool's demand measured per window: the weekly one from the smoothed rates when given (else
 * each week's average), the 5-hour one from each window's average so far. Work goes only to a
 * subscription with room in both windows, and each step's work uses up both at those rates, so
 * during a gap neither is used. Each window resets on its own clock. A subscription without a
 * weekly reading is left out (`unreported`). A 5-hour window opens with a subscription's first
 * work after the last one closed (one not read, or with no window open, is closed), unlike
 * poolForecast's, which restart at once. A subscription Anthropic is rate-limiting takes no
 * work until that ends. Gaps that have ended by `now` are skipped; after a gap the simulation
 * goes on from its end. Every gap in the horizon is listed.
 */
export function poolGaps(
  profiles: ProfileStatus[],
  from: EpochMs,
  smoothed: ReadonlyMap<string, number | null> = new Map(),
  now: EpochMs = from,
  /** With no more use: what is left only comes back as limits reset. */
  noMoreUse = false,
  /**
   * The pool's pace, when it should not come from these subscriptions: a what-if with one more or
   * one fewer (capacityAdvice) keeps the people's pace, which no subscription change alters.
   */
  pace?: PoolGaps['pace'],
  /**
   * The pace at each moment instead of one pace throughout, for a forecast that follows a pattern
   * (last week's, hour by hour). `pace` is still what the result reports.
   */
  paceAt?: (t: EpochMs) => PoolGaps['pace'],
): PoolGaps {
  const slots: JointSlot[] = []
  let weeklyDemand = 0
  let fiveDemand = 0
  let counted = 0
  const rate = (r: number | null | undefined) =>
    r === null || r === undefined || !Number.isFinite(r) ? 0 : Math.max(0, r)
  for (const [index, p] of profiles.entries()) {
    const w = reading(p, 'weekly')
    if (w === null) continue
    counted++
    const weekly = simWindow(w)
    catchUp(weekly, from)
    const f = reading(p, 'fiveHour')
    const five: SimWindow =
      f === null ? { used: 0, resetsAt: null, lengthMs: FIVE_HOURS_MS, known: false } : simWindow(f)
    closeIfOver(five, from)
    const smooth = smoothed.get(p.profile)
    weeklyDemand += rate(
      smooth !== null && smooth !== undefined && Number.isFinite(smooth)
        ? smooth
        : averageBurnRate(w, from),
    )
    if (f !== null) fiveDemand += rate(averageBurnRate(f, from))
    const loginExpired = p.tokenExpiresAt !== null && p.tokenExpiresAt <= from
    const limitedUntil =
      p.rateLimitedUntil !== null && p.rateLimitedUntil > from ? p.rateLimitedUntil : null
    if (!loginExpired) slots.push({ quota: weekly, weekly, five, index, limitedUntil })
  }
  if (pace !== undefined) {
    weeklyDemand = pace.weekly
    fiveDemand = pace.fiveHour
  }
  if (noMoreUse) {
    weeklyDemand = 0
    fiveDemand = 0
  }
  // A week that resets throws away what was left of it; each one after now is noted.
  const unusedAtReset: PoolGaps['unusedAtReset'] = []
  const resetWeek = (s: JointSlot, t: EpochMs) => {
    const resetsAt = s.weekly.resetsAt
    if (resetsAt !== null && resetsAt <= t && resetsAt > now) {
      const unused = 1 - s.weekly.used
      if (unused > 0.005) {
        unusedAtReset.push({ profile: profiles[s.index]?.profile ?? '', at: resetsAt, unused })
      }
    }
    catchUp(s.weekly, t)
  }
  const trace: CapacityPoint[] = []
  const result = (gaps: PoolGap[], lasts: PoolGaps['lasts']): PoolGaps => ({
    counted,
    unreported: profiles.length - counted,
    gaps,
    lasts,
    trace,
    clock: Math.max(now, from),
    capacity: slots.length,
    subscriptions: slots.map((s) => profiles[s.index]?.profile ?? ''),
    pace: { weekly: weeklyDemand, fiveHour: fiveDemand },
    unusedAtReset,
  })
  if (counted === 0) return result([], 'unknown')
  if (slots.length === 0) return result([], 'logins')
  // Samples of what is left, on their own grid, up to (not including) `until`. No work is done
  // between the last step and `until` (the steps are finer, or a gap or idleness holds), so each
  // sample applies the resets due by its time, as stepping there would.
  // One more sample at `now`, in order, so what is left now is read at now and not up to a
  // sample's step earlier: a reset since the last sample shows at once.
  let nextSample = from
  let nowSampled = now < from
  const sample = (at: EpochMs) => {
    let weekly = 0
    let fiveHour = 0
    const weeklyBy: number[] = []
    const fiveHourBy: number[] = []
    const weeklyResetsBy: Array<EpochMs | null> = []
    for (const s of slots) {
      resetWeek(s, at)
      closeIfOver(s.five, at)
      weekly += 1 - s.weekly.used
      weeklyBy.push(1 - s.weekly.used)
      // What a 5-hour window can still take: nothing while Anthropic refuses the subscription or
      // its week is full, and never more than its week leaves, since work in the window spends the
      // week too (as fiveHourLeft, for the bars).
      const refused = s.limitedUntil !== null && s.limitedUntil > at
      const five = isFull(s.weekly) || refused ? 0 : Math.min(1 - s.five.used, 1 - s.weekly.used)
      fiveHour += five
      fiveHourBy.push(five)
      weeklyResetsBy.push(s.weekly.resetsAt)
    }
    trace.push({ at, weekly, fiveHour, weeklyBy, fiveHourBy, weeklyResetsBy })
  }
  const sampleUntil = (until: EpochMs) => {
    for (; nextSample < until; nextSample += TRACE_STEP_MS) {
      if (!nowSampled && now < nextSample) {
        sample(now)
        nowSampled = true
      }
      sample(nextSample)
      if (nextSample === now) nowSampled = true
    }
    if (!nowSampled && now < until) {
      sample(now)
      nowSampled = true
    }
  }

  const step = GAPS_STEP_MS
  let perWeek = (weeklyDemand / HOUR_MS) * step
  let perFive = (fiveDemand / HOUR_MS) * step
  // A pattern may pick up after an idle stretch, so only one pace throughout ends early when idle.
  const idle = paceAt === undefined && perWeek <= 0 && perFive <= 0
  const open = (s: JointSlot, t: EpochMs) =>
    !isFull(s.weekly) && !isFull(s.five) && (s.limitedUntil === null || s.limitedUntil <= t)
  const gaps: PoolGap[] = []
  const end = from + GAPS_HORIZON_MS
  for (let t = from; t <= end; t += step) {
    // Samples before this step first, each with only the resets due by its own time.
    sampleUntil(t)
    for (const s of slots) {
      resetWeek(s, t)
      closeIfOver(s.five, t)
    }
    sampleUntil(t + 1)
    const ready = slots.filter((s) => open(s, t))
    if (ready.length === 0) {
      // The first subscription back ends the gap; a weekly reset wins a tie.
      let first: { at: EpochMs; window: WindowKind | 'rateLimit' } | null = null
      for (const s of slots) {
        const back = availableAfter(s, t)
        if (back === null) continue
        if (
          first === null ||
          back.at < first.at ||
          (back.at === first.at && back.window === 'weekly')
        ) {
          first = back
        }
      }
      const gapEnd = first?.at ?? null
      if (gapEnd === null || gapEnd > now) {
        gaps.push({ start: t, end: gapEnd, endsWith: first?.window ?? null })
      }
      if (gapEnd === null) break
      // Nothing is used during the gap: what is left holds until it ends.
      sampleUntil(Math.min(gapEnd, end + 1))
      // On from the step at which the first subscription takes work again (at least one step on,
      // so the loop always moves).
      t = Math.max(t, from + Math.ceil((gapEnd - from) / step) * step - step)
      continue
    }
    if (idle) break
    if (paceAt !== undefined && !noMoreUse) {
      const at = paceAt(t)
      perWeek = (rate(at.weekly) / HOUR_MS) * step
      perFive = (rate(at.fiveHour) / HOUR_MS) * step
      // An idle step does no work, so it opens no 5-hour window.
      if (perWeek <= 0 && perFive <= 0) continue
    }
    // In claude-master's order as of this step; what one cannot take goes to the next. `left` is
    // the share of this step's work still to place; each subscription takes what its fuller
    // window allows.
    ready.sort(routeOrder)
    let left = 1
    for (const s of ready) {
      if (left <= 0) break
      const byWeek = perWeek > 0 ? (1 - s.weekly.used) / perWeek : Number.POSITIVE_INFINITY
      const byFive = perFive > 0 ? (1 - s.five.used) / perFive : Number.POSITIVE_INFINITY
      const take = Math.min(left, byWeek, byFive)
      if (take <= 0) continue
      // A closed 5-hour window opens with the subscription's work.
      if (s.five.resetsAt === null && s.five.used === 0) s.five.resetsAt = t + s.five.lengthMs
      s.weekly.used = Math.min(1, s.weekly.used + take * perWeek)
      s.five.used = Math.min(1, s.five.used + take * perFive)
      left -= take
    }
  }
  // What is left holds to the horizon after the last step (idle, or a gap with no end).
  sampleUntil(end + 1)
  return result(gaps, gaps.length > 0 ? null : idle ? 'idle' : 'horizon')
}

/** How the outlook reads at a glance. */
export type PoolTone = 'success' | 'warning' | 'error' | 'info'

const ALLOWANCE: Record<WindowKind, string> = {
  weekly: 'weekly allowance',
  fiveHour: '5-hour capacity',
}

/**
 * Whether a forecast covers every subscription. One that covers only those reporting the window
 * says so and never reads as an error: the others may still have room.
 */
export function reportingAll(f: PoolForecast): boolean {
  return f.unreported === 0
}

/** Words naming whose forecast it is when it does not cover every subscription. */
export function among(f: PoolForecast): string {
  return reportingAll(f) ? '' : ` (the ${f.counted} reporting it)`
}

/**
 * What a forecast says at `now`: every subscription it covers has an expired login, the pool is
 * out, it runs out later, it lasts, or there is no reading. `partial` when it covers only the
 * subscriptions reporting the window.
 */
export type ForecastState = 'logins' | 'out' | 'clips' | 'lasts' | 'unknown'

export function forecastState(
  f: PoolForecast,
  now: EpochMs,
): { state: ForecastState; partial: boolean } {
  const partial = !reportingAll(f)
  if (f.lasts === 'logins') return { state: 'logins', partial }
  if (f.clipsAt !== null) return { state: f.clipsAt <= now ? 'out' : 'clips', partial }
  return { state: f.lasts === 'unknown' ? 'unknown' : 'lasts', partial }
}

/**
 * How severe a forecast is, most severe first: nothing can take work, out now, out now among
 * some, runs out later (sooner first), logins expired among some, lasts, unknown. The headline
 * is the most severe forecast, whatever its position or time.
 */
export function forecastSeverity(f: PoolForecast, now: EpochMs): number {
  const { state, partial } = forecastState(f, now)
  switch (state) {
    case 'logins':
      return partial ? 4 : 0
    case 'out':
      return partial ? 2 : 1
    case 'clips':
      return 3
    case 'lasts':
      return 5
    case 'unknown':
      return 6
  }
}

/** How long a run-out lasts, in words (", for 2d 2h"); nothing when no reset time is known. */
function outFor(f: PoolForecast): string {
  return f.clipsAt === null || f.recoversAt === null
    ? ''
    : `, for ${formatCountdown(f.recoversAt - f.clipsAt)}`
}

/** How long a pool that is out now stays out (", for 2d 2h"); nothing when that is unknown. */
function outNowFor(f: PoolForecast, now: EpochMs): string {
  return f.recoversAt === null ? '' : `, for ${formatCountdown(f.recoversAt - now)}`
}

/**
 * The answer to "will we run out?": the most severe forecast, and its tone, with how long the
 * gap lasts when that is known. One window only: the two forecasts are made apart (the weekly
 * one does not see 5-hour gaps; the 5-hour one routes only to weeks with room), so a sentence
 * joining them can be false. Each window's card says its own.
 */
export function forecastHeadline(
  forecasts: PoolForecast[] | null,
  now: EpochMs,
): { tone: PoolTone; headline: string; window: WindowKind | null } {
  if (forecasts === null || forecasts.length === 0) {
    return { tone: 'info', headline: 'Waiting for the first reading.', window: null }
  }
  // On a tie the weekly one leads, whatever the order given: a 5-hour forecast routes only to
  // weeks with room, so when both are out at once it may be the weeks that are full.
  const weeklyFirst = (f: PoolForecast) => (f.window === 'weekly' ? 0 : 1)
  const ranked = [...forecasts].sort(
    (a, b) =>
      forecastSeverity(a, now) - forecastSeverity(b, now) ||
      (a.clipsAt ?? Number.POSITIVE_INFINITY) - (b.clipsAt ?? Number.POSITIVE_INFINITY) ||
      weeklyFirst(a) - weeklyFirst(b),
  )
  const top = ranked[0] as PoolForecast
  const { state, partial } = forecastState(top, now)
  const window = top.window
  switch (state) {
    case 'logins':
      return partial
        ? {
            tone: 'warning',
            headline: `Every subscription reporting its ${ALLOWANCE[window]} has an expired login${among(top)}.`,
            window,
          }
        : {
            tone: 'error',
            headline: 'No subscription can take work: every login has expired.',
            window,
          }
    case 'out':
      return {
        tone: partial ? 'warning' : 'error',
        headline: `The pool is out of ${ALLOWANCE[window]} now${outNowFor(top, now)}${among(top)}.`,
        window,
      }
    case 'clips':
      return {
        tone: 'warning',
        headline: `At this pace the pool runs out of its ${ALLOWANCE[window]} in ${formatCountdown((top.clipsAt as EpochMs) - now)}${outFor(top)}${among(top)}.`,
        window,
      }
    case 'lasts':
      return { tone: 'success', headline: 'At this pace the pool does not run out.', window: null }
    case 'unknown':
      return { tone: 'info', headline: 'No subscription has reported its usage yet.', window: null }
  }
}

/**
 * The answer to "when do I run out, and for how long?", from the pool's first gap: the first
 * time no subscription can take work, whether a weekly or a 5-hour limit (or a rate limit) is
 * what stops each, and how long until the first of them can take work again, which needs room
 * in both its limits. "Runs out in 9h 57m for 1d 19h", then the clock times when the viewer's
 * zone is known ("22:43 until Mon 17:59"). Partial when some subscriptions have no weekly
 * reading, so they may still have room.
 */
export function gapsHeadline(
  g: PoolGaps | null,
  now: EpochMs,
  clock: ((at: EpochMs) => string) | null = null,
): { tone: PoolTone; headline: string; facts: string[] } {
  if (g === null) return { tone: 'info', headline: 'Waiting for the first reading', facts: [] }
  const partial = g.unreported > 0
  const among = partial
    ? [`Based on ${g.counted} of ${g.counted + g.unreported} subscriptions`]
    : []
  if (g.lasts === 'unknown') {
    return { tone: 'info', headline: 'No weekly usage reported yet', facts: [] }
  }
  if (g.lasts === 'logins') {
    return partial
      ? { tone: 'warning', headline: 'Every login has expired', facts: among }
      : {
          tone: 'error',
          headline: 'Every login has expired',
          facts: ['Log in again on the server'],
        }
  }
  const [first] = g.gaps
  if (first === undefined) {
    const days = GAPS_HORIZON_MS / (24 * HOUR_MS)
    return { tone: 'success', headline: `Won't run out in the next ${days} days`, facts: among }
  }
  const out = first.start <= now
  const end = first.end
  const headline = out
    ? end === null
      ? 'Out now · no reset time known'
      : `Out now · back in ${formatCountdown(end - now)}`
    : end === null
      ? `Runs out in ${formatCountdown(first.start - now)} · no reset time known`
      : `Runs out in ${formatCountdown(first.start - now)} for ${formatCountdown(end - first.start)}`
  const times =
    clock === null
      ? []
      : out
        ? end === null
          ? []
          : [`Back ${clock(end)}`]
        : [`${clock(first.start)} until ${end === null ? 'unknown' : clock(end)}`]
  return { tone: out && !partial ? 'error' : 'warning', headline, facts: [...times, ...among] }
}
