import { describe, expect, it } from 'vitest'
import {
  type EpochMs,
  FIVE_HOURS_MS,
  HOUR_MS,
  measuredBlocked,
  measuredResets,
  type ProfileStatus,
  poolGaps,
  replayWeekPerWindow,
  runningBlocked,
  runningWaste,
  type Series,
  WEEK_MS,
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
    // One pace of nothing throughout: no gap.
    expect(poolGaps([a], T, new Map(), T, false, pace).gaps).toEqual([])
  })
})

describe('running totals', () => {
  const times = [T, T + HOUR_MS, T + 2 * HOUR_MS, T + 3 * HOUR_MS]
  it('adds each reset at its moment, from the first time on', () => {
    const points = runningWaste(
      [
        { at: T - HOUR_MS, unused: 9 },
        { at: T + 30 * 60_000, unused: 0.25 },
        { at: T + 2 * HOUR_MS, unused: 0.5 },
      ],
      times,
    )
    expect(points.map(([, v]) => v)).toEqual([0, 0.25, 0.75, 0.75])
  })
  it('adds the hours without tokens as they pass, from the first time on', () => {
    const points = runningBlocked(
      [
        { start: T - HOUR_MS, end: T + 30 * 60_000 },
        { start: T + 2 * HOUR_MS, end: T + 4 * HOUR_MS },
      ],
      times,
    )
    expect(points.map(([, v]) => v)).toEqual([0, 0.5, 0.5, 1.5])
  })
})

describe('measuredBlocked', () => {
  const MIN = 60_000
  // Readings at whole minutes after T.
  const at = (key: string, readings: Array<[number, number]>) => ({
    key,
    points: readings.map(([m, v]): [EpochMs, number] => [T + m * MIN, v]),
  })
  const spans = (
    weekly: ReturnType<typeof at>[],
    five: ReturnType<typeof at>[],
    from: number,
    to: number,
  ) =>
    measuredBlocked(
      { stepMs: STEP, weeklyUsed: weekly, fiveHourUsed: five },
      T + from * MIN,
      T + to * MIN,
    ).map((s) => [(s.start - T) / MIN, (s.end - T) / MIN])
  const cases: Array<{
    name: string
    weekly: ReturnType<typeof at>[]
    five?: ReturnType<typeof at>[]
    from?: number
    to: number
    blocked: number[][]
  }> = [
    {
      name: 'every subscription out of its week or its 5-hour window, joined',
      weekly: [
        at('a', [
          [0, 0.9],
          [10, 1],
          [20, 1],
          [30, 1],
          [40, 1],
        ]),
        at('b', [
          [0, 0.5],
          [10, 0.5],
          [20, 0.5],
          [30, 0.5],
          [40, 0.5],
        ]),
      ],
      five: [
        at('b', [
          [0, 0.2],
          [10, 0.9],
          [20, 1],
          [30, 1],
          [40, 0.1],
        ]),
      ],
      to: 50,
      blocked: [[20, 40]],
    },
    {
      name: 'a subscription stays in the pool across a missing reading',
      weekly: [
        at('a', [
          [0, 1],
          [10, 1],
          [20, 1],
          [30, 1],
        ]),
        at('b', [
          [0, 0.2],
          [10, 0.2],
          [30, 0.2],
        ]),
      ],
      to: 40,
      blocked: [],
    },
    {
      name: 'a 5-hour window freed between weekly readings ends the span then',
      weekly: [
        at('a', [
          [0, 0.2],
          [20, 0.2],
        ]),
      ],
      five: [
        at('a', [
          [0, 1],
          [10, 0.1],
          [20, 0.1],
        ]),
      ],
      to: 30,
      blocked: [[0, 10]],
    },
    {
      name: 'a reading stands for under half an hour',
      weekly: [
        at('a', [
          [0, 0.2],
          [10, 0.2],
          [20, 0.2],
          [30, 0.2],
        ]),
      ],
      five: [at('a', [[0, 1]])],
      to: 60,
      blocked: [[0, 30]],
    },
    {
      name: 'the state at the start comes from the readings before it',
      weekly: [
        at('a', [
          [0, 1],
          [10, 1],
          [20, 1],
        ]),
      ],
      from: 5,
      to: 25,
      blocked: [[5, 25]],
    },
    {
      name: 'the last state holds to the cutoff, or half an hour, whichever first',
      weekly: [
        at('a', [
          [0, 1],
          [10, 1],
          [20, 1],
        ]),
      ],
      to: 120,
      blocked: [[0, 50]],
    },
    { name: 'nothing read, nothing known', weekly: [], to: 60, blocked: [] },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(spans(c.weekly, c.five ?? [], c.from ?? 0, c.to)).toEqual(c.blocked)
    })
  }
})
