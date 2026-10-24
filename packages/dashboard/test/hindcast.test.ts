import { describe, expect, it } from 'vitest'
import {
  type EpochMs,
  extendHindcast,
  FIVE_HOURS_MS,
  GAPS_HORIZON_MS,
  type HindcastPoint,
  HOUR_MS,
  hindcast,
  hindcastTimes,
  measuredResets,
  type PoolGaps,
  type ProfileStatus,
  poolGaps,
  profilesAt,
  type QuotaHistory,
  replayWeekPerWindow,
  resetSpikes,
  type Series,
  WEEK_MS,
  wasteAndClipping,
  weekAgoPace,
} from '../src/core/index'

const T = Date.UTC(2026, 9, 20, 12)
const STEP = 10 * 60_000

/** A series every step over [from, to), its value a function of the bucket start. */
function every(key: string, from: EpochMs, to: EpochMs, value: (t: EpochMs) => number): Series {
  const points: Array<[EpochMs, number]> = []
  for (let t = from; t < to; t += STEP) points.push([t, value(t)])
  return { key, points }
}

/**
 * One subscription read for two days before T, its week rising at `perHour` from `usedAtT` at T
 * and resetting `resetsIn` after T; its 5-hour windows open, each rising at four times the pace.
 */
function steady(perHour: number, usedAtT: number, resetsIn: number): QuotaHistory {
  const from = T - 48 * HOUR_MS
  const to = T + 2 * HOUR_MS
  const fiveStart = (t: EpochMs) =>
    T - FIVE_HOURS_MS + Math.floor((t - T) / FIVE_HOURS_MS + 1) * FIVE_HOURS_MS
  return {
    stepMs: STEP,
    weeklyUsed: [every('a', from, to, (t) => Math.max(0, usedAtT + ((t - T) / HOUR_MS) * perHour))],
    weeklyResetsInSeconds: [every('a', from, to, (t) => (T + resetsIn - t) / 1000)],
    fiveHourUsed: [
      every('a', from, to, (t) =>
        Math.min(1, ((t - (fiveStart(t) - FIVE_HOURS_MS)) / HOUR_MS) * perHour * 4),
      ),
    ],
    fiveHourResetsInSeconds: [every('a', from, to, (t) => (fiveStart(t) - t) / 1000)],
  }
}

describe('profilesAt', () => {
  const history: QuotaHistory = {
    stepMs: STEP,
    weeklyUsed: [
      {
        key: 'a',
        points: [
          [T - 2 * STEP, 0.4],
          [T - STEP, 0.5],
          [T, 0.9],
        ],
      },
      { key: 'stale', points: [[T - 40 * 60_000 - STEP, 0.3]] },
    ],
    weeklyResetsInSeconds: [{ key: 'a', points: [[T - STEP, 3600]] }],
    fiveHourUsed: [{ key: 'a', points: [[T - 3 * HOUR_MS, 0.2]] }],
    fiveHourResetsInSeconds: [],
  }

  it('reads the last bucket that ended by then, never one still filling', () => {
    const [a] = profilesAt(history, T)
    expect(a?.weekly.usedFraction).toBe(0.5)
  })

  it('times a countdown from its bucket start', () => {
    expect(profilesAt(history, T)[0]?.weekly.resetsAt).toBe(T - STEP + HOUR_MS)
  })

  it("counts a window that reset inside the reading's bucket as unused", () => {
    // The week reset 5 minutes into the last bucket: its highest share is the old week's 100%,
    // its countdown already the new week's. So for a 5-hour window.
    const reset = T - 5 * 60_000
    const reread: QuotaHistory = {
      stepMs: STEP,
      weeklyUsed: [{ key: 'a', points: [[T - STEP, 1]] }],
      weeklyResetsInSeconds: [{ key: 'a', points: [[T - STEP, (reset + WEEK_MS - T) / 1000]] }],
      fiveHourUsed: [{ key: 'a', points: [[T - STEP, 1]] }],
      fiveHourResetsInSeconds: [
        { key: 'a', points: [[T - STEP, (reset + FIVE_HOURS_MS - T) / 1000]] },
      ],
    }
    const [a] = profilesAt(reread, T)
    expect(a?.weekly.usedFraction).toBe(0)
    expect(a?.fiveHour?.usedFraction).toBe(0)
    // A window that began before the bucket keeps its reading.
    const [b] = profilesAt(
      {
        ...reread,
        weeklyResetsInSeconds: [
          { key: 'a', points: [[T - STEP, (T - 3 * STEP + WEEK_MS - T) / 1000]] },
        ],
      },
      T,
    )
    expect(b?.weekly.usedFraction).toBe(1)
  })

  it('reads a 5-hour countdown of zero as reset when read, and a weekly one as not known', () => {
    const zero: QuotaHistory = {
      stepMs: STEP,
      weeklyUsed: [{ key: 'a', points: [[T - STEP, 1]] }],
      weeklyResetsInSeconds: [{ key: 'a', points: [[T - STEP, 0]] }],
      fiveHourUsed: [{ key: 'a', points: [[T - STEP, 1]] }],
      fiveHourResetsInSeconds: [{ key: 'a', points: [[T - STEP, 0]] }],
    }
    const [a] = profilesAt(zero, T)
    expect(a?.weekly.resetsAt).toBeNull()
    expect(a?.fiveHour).toEqual({ usedFraction: 1, resetsAt: T - STEP, lengthMs: FIVE_HOURS_MS })
  })

  it('leaves out a subscription whose weekly reading is over half an hour old', () => {
    expect(profilesAt(history, T).map((p) => p.profile)).toEqual(['a'])
  })

  it('keeps a 5-hour reading up to a window old, with no reset when none was reported', () => {
    expect(profilesAt(history, T)[0]?.fiveHour).toEqual({
      usedFraction: 0.2,
      resetsAt: null,
      lengthMs: FIVE_HOURS_MS,
    })
    const later = T + 3 * HOUR_MS
    const read: QuotaHistory = {
      ...history,
      weeklyUsed: [{ key: 'a', points: [[later - STEP, 0.5]] }],
    }
    expect(profilesAt(read, later)[0]?.fiveHour).toBeNull()
  })

  it('has no profile before any reading', () => {
    expect(profilesAt(history, T - 2 * HOUR_MS)).toEqual([])
  })
})

describe('wasteAndClipping', () => {
  const gaps = (over: Partial<PoolGaps>): PoolGaps => ({
    counted: 1,
    unreported: 0,
    gaps: [],
    lasts: null,
    trace: [],
    clock: T,
    capacity: 1,
    subscriptions: ['a'],
    pace: { weekly: 0.05, fiveHour: 0.2 },
    unusedAtReset: [],
    ...over,
  })

  it('counts the demand of each gap, an open one to the horizon', () => {
    const point = wasteAndClipping(
      gaps({
        gaps: [
          { start: T + HOUR_MS, end: T + 3 * HOUR_MS, endsWith: 'fiveHour' },
          { start: T + GAPS_HORIZON_MS - HOUR_MS, end: null, endsWith: null },
        ],
      }),
      T,
    )
    expect(point.clippedHours).toBe(3)
    expect(point.clipped).toBeCloseTo(0.15)
    expect(point.wasted).toBe(0)
  })

  it('sums what every reset throws away', () => {
    const point = wasteAndClipping(
      gaps({
        unusedAtReset: [
          { profile: 'a', at: T + HOUR_MS, unused: 0.25 },
          { profile: 'b', at: T + 2 * HOUR_MS, unused: 0.5 },
        ],
      }),
      T,
    )
    expect(point.wasted).toBe(0.75)
    expect(point.clipped).toBe(0)
  })
})

describe('wasteAndClipping from a later time', () => {
  it('counts only what is still to come: later resets, and the gaps from then on', () => {
    const gaps: PoolGaps = {
      counted: 2,
      unreported: 0,
      gaps: [{ start: T + 10 * HOUR_MS, end: T + 14 * HOUR_MS, endsWith: 'fiveHour' }],
      lasts: null,
      trace: [],
      clock: T,
      capacity: 2,
      subscriptions: ['a', 'b'],
      pace: { weekly: 0.1, fiveHour: 0.4 },
      unusedAtReset: [
        { profile: 'a', at: T + 5 * HOUR_MS, unused: 0.25 },
        { profile: 'b', at: T + 20 * HOUR_MS, unused: 0.5 },
      ],
    }
    expect(wasteAndClipping(gaps)).toMatchObject({ at: T, wasted: 0.75, clippedHours: 4 })
    const later = wasteAndClipping(gaps, T + 12 * HOUR_MS)
    expect(later).toMatchObject({ at: T + 12 * HOUR_MS, wasted: 0.5, clippedHours: 2 })
    expect(later.clipped).toBeCloseTo(0.2)
    expect(wasteAndClipping(gaps, T + 21 * HOUR_MS)).toMatchObject({ wasted: 0, clipped: 0 })
  })
})

describe('hindcast', () => {
  it('clips when the pace runs the week out before it resets', () => {
    // Half the week left at 2% an hour: gone in 25 hours, back in 100.
    const [point] = hindcast(steady(0.02, 0.5, 100 * HOUR_MS), [T])
    expect(point?.wasted).toBe(0)
    expect(point?.clippedHours).toBeGreaterThan(70)
    expect(point?.clipped).toBeCloseTo((point?.clippedHours ?? 0) * 0.02, 2)
  })

  it('wastes what a slow pace leaves at the reset', () => {
    // 0.1% an hour for 100 hours leaves about 40% of the week.
    const [point] = hindcast(steady(0.001, 0.5, 100 * HOUR_MS), [T])
    expect(point?.clipped).toBe(0)
    expect(point?.wasted).toBeCloseTo(0.4, 1)
  })

  it('uses only the readings up to each time', () => {
    const history = steady(0.02, 0.5, 100 * HOUR_MS)
    const [early] = hindcast(history, [T - HOUR_MS])
    const cut: QuotaHistory = {
      ...history,
      weeklyUsed: history.weeklyUsed.map((s) => ({
        ...s,
        points: s.points.filter(([t]) => t < T - HOUR_MS),
      })),
      weeklyResetsInSeconds: history.weeklyResetsInSeconds.map((s) => ({
        ...s,
        points: s.points.filter(([t]) => t < T - HOUR_MS),
      })),
      fiveHourUsed: history.fiveHourUsed.map((s) => ({
        ...s,
        points: s.points.filter(([t]) => t < T - HOUR_MS),
      })),
      fiveHourResetsInSeconds: history.fiveHourResetsInSeconds.map((s) => ({
        ...s,
        points: s.points.filter(([t]) => t < T - HOUR_MS),
      })),
    }
    expect(hindcast(cut, [T - HOUR_MS])[0]).toEqual(early)
  })

  it('has nothing to say before any subscription was read', () => {
    expect(hindcast(steady(0.02, 0.5, 100 * HOUR_MS), [T - 3 * 24 * HOUR_MS])).toEqual([null])
  })
})

describe('extendHindcast', () => {
  it('keeps settled hours and works out new and recent ones', () => {
    const history = steady(0.02, 0.5, 100 * HOUR_MS)
    const kept: HindcastPoint = { at: T - HOUR_MS, wasted: 9, clipped: 9, clippedHours: 9 }
    const recent: HindcastPoint = { at: T, wasted: 9, clipped: 9, clippedHours: 9 }
    const next = extendHindcast(
      new Map([
        [T - HOUR_MS, kept],
        [T, recent],
      ]),
      history,
      [T - HOUR_MS, T, T + HOUR_MS],
      T,
    )
    expect(next.get(T - HOUR_MS)).toBe(kept)
    expect(next.get(T)).toEqual(hindcast(history, [T])[0])
    expect(next.has(T + HOUR_MS)).toBe(true)
    expect([...next.keys()]).toEqual([T - HOUR_MS, T, T + HOUR_MS])
  })

  it('drops hours that have left the week', () => {
    const history = steady(0.02, 0.5, 100 * HOUR_MS)
    const old: HindcastPoint = { at: T - 2 * HOUR_MS, wasted: 0, clipped: 0, clippedHours: 0 }
    const next = extendHindcast(new Map([[T - 2 * HOUR_MS, old]]), history, [T], T)
    expect(next.has(T - 2 * HOUR_MS)).toBe(false)
  })
})

describe('hindcastTimes', () => {
  it('is every hour of the last week, oldest first, ending on the hour', () => {
    const times = hindcastTimes(T + 25 * 60_000)
    expect(times).toHaveLength(169)
    expect(times[0]).toBe(T - WEEK_MS)
    expect(times.at(-1)).toBe(T)
  })
})

describe('measuredResets', () => {
  // A week resetting at T + 5 minutes: its countdown, read every step, names the next week after.
  const reset = T + 5 * 60_000
  const countdown = every('a', T - HOUR_MS, T + HOUR_MS, (t) =>
    t < reset - STEP + 1 ? (reset - t) / 1000 : (reset + WEEK_MS - t) / 1000,
  )
  const history = (usedBefore: number) => ({
    stepMs: STEP,
    weeklyUsed: [every('a', T - HOUR_MS, T + HOUR_MS, (t) => (t <= reset ? usedBefore : 0.01))],
    weeklyResetsInSeconds: [countdown],
  })

  it('finds the reset and what the week before it left', () => {
    expect(measuredResets(history(0.7), T - HOUR_MS, T + HOUR_MS)).toEqual([
      { profile: 'a', at: reset, unused: expect.closeTo(0.3, 9) },
    ])
  })

  it('counts a week used up as nothing thrown away', () => {
    expect(measuredResets(history(1), T - HOUR_MS, T + HOUR_MS)[0]?.unused).toBe(0)
  })

  it('keeps to the span asked for, and needs a reading of the share before the reset', () => {
    expect(measuredResets(history(0.7), reset + 1, T + HOUR_MS)).toEqual([])
    expect(measuredResets({ ...history(0.7), weeklyUsed: [] }, T - HOUR_MS, T + HOUR_MS)).toEqual(
      [],
    )
  })
})

describe('measuredResets at a bucket starting on the reset', () => {
  // The week resets at T, a bucket's start: that bucket holds the new week only.
  const countdown = every('a', T - HOUR_MS, T + HOUR_MS, (t) =>
    t < T ? (T - t) / 1000 : (T + WEEK_MS - t) / 1000,
  )
  it("does not take the new week's share for the old week's", () => {
    const used = every('a', T - HOUR_MS, T + HOUR_MS, (t) => (t < T ? 0.01 : 0.03))
    const [reset] = measuredResets(
      { stepMs: STEP, weeklyUsed: [used], weeklyResetsInSeconds: [countdown] },
      T - HOUR_MS,
      T + HOUR_MS,
    )
    expect(reset?.at).toBe(T)
    expect(reset?.unused).toBeCloseTo(0.99, 9)
  })
  it("leaves out a reset with only the new week's share read", () => {
    const used = { key: 'a', points: [[T, 0.03]] as Array<[EpochMs, number]> }
    expect(
      measuredResets(
        { stepMs: STEP, weeklyUsed: [used], weeklyResetsInSeconds: [countdown] },
        T - HOUR_MS,
        T + HOUR_MS,
      ),
    ).toEqual([])
  })
})

describe('replayWeekPerWindow', () => {
  it("is the pool's measured cost, else the forecast's own, else unknown", () => {
    expect(replayWeekPerWindow(0.25, { weekly: 0.05, fiveHour: 0.1 })).toBe(0.25)
    expect(replayWeekPerWindow(null, { weekly: 0.05, fiveHour: 0.2 })).toBe(0.25)
    expect(replayWeekPerWindow(null, { weekly: 0.05, fiveHour: 0 })).toBeNull()
    expect(replayWeekPerWindow(null, null)).toBeNull()
  })
})

describe('resetSpikes', () => {
  it('is nothing at each time and a spike at each reset, same-moment resets added', () => {
    const points = resetSpikes(
      [
        { at: T + 30 * 60_000, unused: 0.25 },
        { at: T + 30 * 60_000, unused: 0.5 },
      ],
      [T, T + HOUR_MS],
    )
    expect(points).toEqual([
      [T, 0],
      [T + 29 * 60_000, 0],
      [T + 30 * 60_000, 0.75],
      [T + 31 * 60_000, 0],
      [T + HOUR_MS, 0],
    ])
  })

  it('lets a time within the spike give way', () => {
    expect(
      resetSpikes([{ at: T, unused: 0.5 }], [T, T + HOUR_MS]).filter(([t]) => t === T),
    ).toEqual([[T, 0.5]])
  })
})

describe('weekAgoPace', () => {
  it("is the pool's use in the same hour a week before, the 5-hour pace through the ratio", () => {
    const start = T - WEEK_MS
    // a uses 2% an hour, b 1% an hour, through the hour a week before T.
    const used = (key: string, perHour: number) =>
      every(
        key,
        start - HOUR_MS,
        start + 2 * HOUR_MS,
        (t) => 0.2 + ((t - start) / HOUR_MS) * perHour,
      )
    const paceAt = weekAgoPace([used('a', 0.02), used('b', 0.01)], 0.25)
    const pace = paceAt(T + 30 * 60_000)
    expect(pace.weekly).toBeCloseTo(0.03, 6)
    expect(pace.fiveHour).toBeCloseTo(pace.weekly / 0.25, 6)
    // No readings that hour: nothing used.
    expect(paceAt(T + 5 * HOUR_MS)).toEqual({ weekly: 0, fiveHour: 0 })
  })
})

describe('poolGaps at a pace that changes', () => {
  const a: ProfileStatus = {
    profile: 'a',
    band: 'ok',
    weekly: { usedFraction: 0.5, resetsAt: T + 100 * HOUR_MS, lengthMs: WEEK_MS },
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
  }
  const pace = { weekly: 0, fiveHour: 0 }

  it('opens no 5-hour window in an idle stretch: as if it started at the first work', () => {
    // A closed 5-hour window; idle four hours, then 5% of the week and 25% of a window an hour:
    // a window fills an hour before it resets, so where it opened shows in when the gap starts.
    const closed: ProfileStatus = {
      ...a,
      fiveHour: { usedFraction: 0, resetsAt: null, lengthMs: FIVE_HOURS_MS },
    }
    const busy = { weekly: 0.05, fiveHour: 0.25 }
    const paceAt = (t: EpochMs) => (t < T + 4 * HOUR_MS ? { weekly: 0, fiveHour: 0 } : busy)
    const replayed = poolGaps([closed], T, new Map(), T, false, pace, paceAt)
    const later = T + 4 * HOUR_MS
    const fromWork = poolGaps(
      [{ ...closed, weekly: { ...closed.weekly } }],
      later,
      new Map(),
      later,
      false,
      busy,
    )
    expect(replayed.gaps[0]?.start).toBe(fromWork.gaps[0]?.start)
  })

  it('uses nothing while the pattern is idle and runs out once it picks up', () => {
    // Idle for a day, then 5% an hour: the half week left lasts 10 hours.
    const paceAt = (t: EpochMs) => ({ weekly: t < T + 24 * HOUR_MS ? 0 : 0.05, fiveHour: 0 })
    const gaps = poolGaps([a], T, new Map(), T, false, pace, paceAt)
    expect(gaps.gaps[0]?.start).toBeGreaterThanOrEqual(T + 33 * HOUR_MS)
    expect(gaps.gaps[0]?.start).toBeLessThanOrEqual(T + 35 * HOUR_MS)
    // The clipping follows the pattern's pace through the gap: 5% an hour until the reset.
    const point = wasteAndClipping(gaps, T, paceAt)
    expect(point.clipped).toBeCloseTo(point.clippedHours * 0.05, 2)
    // One pace of nothing throughout: no gap.
    expect(poolGaps([a], T, new Map(), T, false, pace).gaps).toEqual([])
  })
})
