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
  type PoolGaps,
  profilesAt,
  type QuotaHistory,
  type Series,
  WEEK_MS,
  wasteAndClipping,
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
