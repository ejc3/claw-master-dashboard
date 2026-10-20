import { describe, expect, it } from 'vitest'
import { routeOrder, type Slot } from '../src/core/forecast'
import {
  averageBurnRate,
  burnRate,
  FIVE_HOURS_MS,
  forecastHeadline,
  HOUR_MS,
  type PoolForecast,
  type ProfileStatus,
  poolBurnRate,
  poolForecast,
  poolPace,
  poolRates,
  type QuotaWindow,
  WEEK_MS,
  weekPerFiveHourWindow,
} from '../src/core/index'
import { lastReady } from '../src/react/hooks'

const NOW = Date.UTC(2026, 9, 9, 12)
const MIN = 60_000

function weekly(usedFraction: number | null, resetsIn = 6 * 24 * HOUR_MS): QuotaWindow {
  return { usedFraction, resetsAt: NOW + resetsIn, lengthMs: WEEK_MS }
}

function profile(name: string, overrides: Partial<ProfileStatus> = {}): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly: weekly(0.5),
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...overrides,
  }
}

const rates = (entries: Record<string, number>) => new Map(Object.entries(entries))

// Within one simulation step (10 minutes for weekly windows) of the expected time.
function expectNear(actual: number | null, expected: number, within = 10 * MIN) {
  expect(actual).not.toBeNull()
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(within)
}

describe('burnRate', () => {
  it('adds the rises over the span and ignores a reset', () => {
    const points: Array<[number, number]> = [
      [NOW - 4 * HOUR_MS, 0.8],
      [NOW - 3 * HOUR_MS, 0.9],
      [NOW - 2 * HOUR_MS, 0.05], // reset: 0.05 used since it
      [NOW - HOUR_MS, 0.15],
      [NOW, 0.25],
    ]
    // Rises 0.1 + 0.05 + 0.1 + 0.1 = 0.35 over 4 hours.
    expect(burnRate(points, NOW, 24 * HOUR_MS)).toBeCloseTo(0.35 / 4, 9)
  })

  it('reads only the span, and needs two readings in it', () => {
    const points: Array<[number, number]> = [
      [NOW - 30 * HOUR_MS, 0],
      [NOW - 2 * HOUR_MS, 0.5],
      [NOW, 0.6],
    ]
    expect(burnRate(points, NOW, 24 * HOUR_MS)).toBeCloseTo(0.05, 9)
    expect(burnRate([[NOW, 0.6]], NOW, 24 * HOUR_MS)).toBeNull()
    expect(burnRate([], NOW, 24 * HOUR_MS)).toBeNull()
  })
})

/** Readings every 10 minutes over the `hours` to NOW, rising `perHour`; reset every `every` hours. */
function rising(
  key: string,
  hours: number,
  perHour: number,
  every: number | null = null,
): { key: string; points: Array<[number, number]> } {
  const points: Array<[number, number]> = []
  for (let m = 0; m <= hours * 60; m += 10) {
    const h = m / 60
    const into = every === null ? h : h % every
    points.push([NOW - (hours - h) * HOUR_MS, Math.min(1, into * perHour)])
  }
  return { key, points }
}

describe('poolBurnRate', () => {
  it("is the pool's rise over the longest coverage, not the sum of each one's rate", () => {
    // One has risen 0.02 an hour all day; one joined two hours ago and took 0.02 an hour since:
    // the pool's work moved, it did not double. Each one's own rate sums to 0.04.
    const old = rising('a', 24, 0.02)
    const fresh = rising('b', 2, 0.02)
    expect(poolBurnRate([old, fresh], NOW, 24 * HOUR_MS)).toBeCloseTo((0.48 + 0.04) / 24, 9)
    const apart = [old, fresh].reduce(
      (sum, s) => sum + (burnRate(s.points, NOW, 24 * HOUR_MS) ?? 0),
      0,
    )
    expect(apart).toBeCloseTo(0.04, 9)
  })

  it("counts a newcomer's first minutes: the hour of readings is the pool's, not each one's", () => {
    // Flat all day; a newcomer took 0.1 in its first half hour.
    const flat = rising('a', 24, 0)
    const newcomer = rising('b', 0.5, 0.2)
    expect(poolBurnRate([flat, newcomer], NOW, 24 * HOUR_MS)).toBeCloseTo(0.1 / 24, 9)
  })

  it('is null without an hour of readings', () => {
    expect(poolBurnRate([], NOW, 24 * HOUR_MS)).toBeNull()
    expect(poolBurnRate([{ key: 'a', points: [[NOW, 0.5]] }], NOW, 24 * HOUR_MS)).toBeNull()
  })
})

// Over 48 hours the week rises 0.01 an hour (0.48), while each 5-hour window fills in 4 hours and
// resets an hour later: nine full windows and three hours of the tenth (9.75).
const weeklyA = rising('a', 48, 0.01)
const fiveA = rising('a', 48, 0.25, 5)

describe('weekPerFiveHourWindow', () => {
  it('divides the weekly rise by the 5-hour rise, resets counted as new use', () => {
    expect(weekPerFiveHourWindow([weeklyA], [fiveA], NOW)).toBeCloseTo(0.48 / 9.75, 9)
  })

  it('takes both rises over the time both windows were read', () => {
    // 5-hour readings for only the last day: the week's rise over that day (0.24), not its 48
    // hours (0.48), against the 5-hour rise.
    const lastDay = { key: 'a', points: fiveA.points.filter(([t]) => t >= NOW - 24 * HOUR_MS) }
    // From NOW-24h a window is full; four more fill, and the last runs three hours: 4.75.
    expect(weekPerFiveHourWindow([weeklyA], [lastDay], NOW)).toBeCloseTo(0.24 / 4.75, 9)
  })

  it('measures both from the same first and last reading when buckets are missing', () => {
    // The week is not read at NOW-3h, so both rises run from NOW-2h: 0.1 of the week against 0.75
    // of a window (not 0.8 of one from NOW-3h).
    const h = (n: number) => NOW - n * HOUR_MS
    const week: Array<[number, number]> = [
      [h(4), 0],
      [h(2), 0.1],
      [h(0), 0.2],
    ]
    const fiveHour: Array<[number, number]> = [
      [h(3), 0.2],
      [h(2), 0.25],
      [h(0), 1],
    ]
    expect(
      weekPerFiveHourWindow([{ key: 'a', points: week }], [{ key: 'a', points: fiveHour }], NOW),
    ).toBeCloseTo(0.1 / 0.75, 9)
  })

  it('counts only subscriptions read in both windows', () => {
    // b's week rose too, but with no 5-hour readings it says nothing about the cost.
    const r = weekPerFiveHourWindow([weeklyA, rising('b', 48, 0.02)], [fiveA], NOW)
    expect(r).toBeCloseTo(weekPerFiveHourWindow([weeklyA], [fiveA], NOW) as number, 9)
  })

  it('is null with less than half a window of 5-hour use', () => {
    expect(
      weekPerFiveHourWindow([rising('a', 48, 0.001)], [rising('a', 48, 0.005)], NOW),
    ).toBeNull()
    expect(weekPerFiveHourWindow([], [], NOW)).toBeNull()
  })
})

describe('poolPace', () => {
  const measured = { weekly: 0.09, fiveHour: 0.4 }

  it("takes the pool's weekly rate and the 5-hour pace that same work makes", () => {
    expect(poolPace(measured, { weekly: 0.06, weekPerWindow: 0.25 })).toEqual({
      weekly: 0.06,
      fiveHour: 0.24,
    })
  })

  it('keeps what the subscriptions measure where the readings cannot tell', () => {
    expect(poolPace(measured, { weekly: null, weekPerWindow: null })).toEqual(measured)
    expect(poolPace(measured, { weekly: 0.06, weekPerWindow: null })).toEqual({
      weekly: 0.06,
      fiveHour: 0.4,
    })
    // No pool rate: the 5-hour pace follows the subscriptions' weekly one.
    expect(poolPace(measured, { weekly: null, weekPerWindow: 0.3 }).fiveHour).toBeCloseTo(0.3, 9)
  })

  it('reads both from the same readings in poolRates', () => {
    const rates = poolRates([weeklyA], [fiveA], NOW)
    expect(rates.weekly).toBeCloseTo(0.01, 9)
    expect(rates.weekPerWindow).toBeCloseTo(
      weekPerFiveHourWindow([weeklyA], [fiveA], NOW) as number,
      9,
    )
  })
})

describe('averageBurnRate', () => {
  it('is the used share over the time the window has run', () => {
    // Half of a 5-hour window gone, half its allowance used: 0.2 per hour.
    const w: QuotaWindow = {
      usedFraction: 0.5,
      resetsAt: NOW + 2.5 * HOUR_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    expect(averageBurnRate(w, NOW)).toBeCloseTo(0.2, 9)
    expect(averageBurnRate({ ...w, usedFraction: null }, NOW)).toBeNull()
    expect(averageBurnRate({ ...w, resetsAt: null }, NOW)).toBeNull()
  })
})

describe('poolForecast', () => {
  it('clips when the room left across the pool is used at the pool rate', () => {
    // Room 0.5 + 0.5 = 1 allowance, demand 0.1 + 0.1 = 0.2 per hour: 5 hours.
    const f = poolForecast([profile('a'), profile('b')], 'weekly', NOW, rates({ a: 0.1, b: 0.1 }))
    expect(f.used).toBeCloseTo(0.5, 9)
    expect(f.burnPerHour).toBeCloseTo(0.2, 9)
    expectNear(f.clipsAt, NOW + 5 * HOUR_MS)
    expect(f.recoversAt).toBe(NOW + 6 * 24 * HOUR_MS)
    expect(f.lasts).toBeNull()
  })

  it('moves demand to subscriptions that still have room', () => {
    // a has 0.1 left and b 1.0: a full a does not clip the pool; 1.1 at 0.2 per hour.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.9) }), profile('b', { weekly: weekly(0) })],
      'weekly',
      NOW,
      rates({ a: 0.1, b: 0.1 }),
    )
    expectNear(f.clipsAt, NOW + 5.5 * HOUR_MS)
  })

  it('gives a subscription its room back when its window resets', () => {
    // 0.2 left at 0.2 per hour would clip at 1h, but a (soonest reset, so it takes the load)
    // fills at 30m just as it resets; then its whole allowance lasts 5h, and b's 0.1 30m more.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.9, 30 * MIN) }), profile('b', { weekly: weekly(0.9) })],
      'weekly',
      NOW,
      rates({ a: 0.1, b: 0.1 }),
    )
    expectNear(f.clipsAt, NOW + 6 * HOUR_MS)
  })

  it('reports a pool already used up, and when it takes work again', () => {
    const f = poolForecast(
      [
        profile('a', { weekly: weekly(1, 3 * HOUR_MS) }),
        profile('b', { weekly: weekly(1, 9 * HOUR_MS) }),
      ],
      'weekly',
      NOW,
    )
    expect(f.clipsAt).toBe(NOW)
    expect(f.recoversAt).toBe(NOW + 3 * HOUR_MS)
  })

  it('lasts when nothing is used, or nothing runs out within the horizon', () => {
    const idle = poolForecast([profile('a')], 'weekly', NOW, rates({ a: 0 }))
    expect(idle).toMatchObject({ clipsAt: null, lasts: 'idle' })
    const slow = poolForecast([profile('a')], 'weekly', NOW, rates({ a: 0.001 }))
    expect(slow).toMatchObject({ clipsAt: null, lasts: 'horizon' })
  })

  it('counts no room for an expired login, though its use counts toward the mean', () => {
    const expired = profile('b', { weekly: weekly(0), tokenExpiresAt: NOW - MIN })
    const f = poolForecast([profile('a'), expired], 'weekly', NOW, rates({ a: 0.1 }))
    expect(f.used).toBeCloseTo(0.25, 9)
    // Only a's 0.5 is room: 5 hours at 0.1 per hour.
    expectNear(f.clipsAt, NOW + 5 * HOUR_MS)
  })

  it('falls back to the average since the window began without a smoothed rate', () => {
    // Half of a 5-hour window gone with 0.6 used: 0.24 per hour, so the 0.4 left lasts 1h40m,
    // before the window resets at 2h30m.
    const five: QuotaWindow = {
      usedFraction: 0.6,
      resetsAt: NOW + 2.5 * HOUR_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    const f = poolForecast([profile('a', { fiveHour: five })], 'fiveHour', NOW)
    expect(f.burnPerHour).toBeCloseTo(0.24, 9)
    expect(f.counted).toBe(1)
    expectNear(f.clipsAt, NOW + (0.4 / 0.24) * HOUR_MS, 2 * MIN)
    expect(f.recoversAt).toBe(NOW + 2.5 * HOUR_MS)
  })

  it('lasts when the pace exactly matches the window', () => {
    // 0.5 used halfway through: it runs out just as the window resets, every window.
    const five: QuotaWindow = {
      usedFraction: 0.5,
      resetsAt: NOW + 2.5 * HOUR_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    expect(poolForecast([profile('a', { fiveHour: five })], 'fiveHour', NOW).lasts).toBe('horizon')
  })

  it('is unknown with no reading of the window', () => {
    const f = poolForecast([profile('a'), profile('b')], 'fiveHour', NOW)
    expect(f).toMatchObject({ counted: 0, used: null, clipsAt: null, lasts: 'unknown' })
    const none = poolForecast([profile('a', { weekly: weekly(null) })], 'weekly', NOW)
    expect(none.lasts).toBe('unknown')
  })
})

describe('forecastHeadline', () => {
  const base = {
    counted: 2,
    unreported: 0,
    smoothedCount: 0,
    used: 0.5,
    burnPerHour: 0.1,
    recoversAt: null,
  }
  const weeklyAt = (clipsAt: number | null, lasts: PoolForecast['lasts'] = null): PoolForecast => ({
    ...base,
    window: 'weekly',
    clipsAt,
    lasts,
  })
  const fiveAt = (clipsAt: number | null, lasts: PoolForecast['lasts'] = null): PoolForecast => ({
    ...base,
    window: 'fiveHour',
    clipsAt,
    lasts,
  })

  it('leads with the soonest run-out', () => {
    const h = forecastHeadline([weeklyAt(null, 'horizon'), fiveAt(NOW + 2 * HOUR_MS)], NOW)
    expect(h).toEqual({
      tone: 'warning',
      headline: 'At this pace the pool runs out of its 5-hour capacity in 2h.',
      window: 'fiveHour',
    })
  })

  it('says how long the gap lasts, for the most severe window only', () => {
    const five = {
      ...fiveAt(NOW + 19 * MIN),
      recoversAt: NOW + 19 * MIN + 206 * MIN,
      unreported: 3,
      counted: 1,
    }
    const weekly = { ...weeklyAt(NOW + 517 * MIN), recoversAt: NOW + 517 * MIN + 50 * HOUR_MS }
    expect(forecastHeadline([weekly, five], NOW)).toEqual({
      tone: 'warning',
      headline:
        'At this pace the pool runs out of its 5-hour capacity in 19m, for 3h 26m (the 1 reporting it).',
      window: 'fiveHour',
    })
    expect(
      forecastHeadline([{ ...fiveAt(NOW), recoversAt: NOW + 3 * HOUR_MS }], NOW).headline,
    ).toBe('The pool is out of 5-hour capacity now, for 3h.')
  })

  it('says when the pool is out now', () => {
    const h = forecastHeadline([weeklyAt(NOW), fiveAt(null, 'horizon')], NOW)
    expect(h).toMatchObject({ tone: 'error', window: 'weekly' })
    expect(h.headline).toBe('The pool is out of weekly allowance now.')
  })

  it('reads success when nothing runs out, and info without readings', () => {
    expect(forecastHeadline([weeklyAt(null, 'horizon'), fiveAt(null, 'unknown')], NOW).tone).toBe(
      'success',
    )
    expect(forecastHeadline([weeklyAt(null, 'unknown'), fiveAt(null, 'unknown')], NOW).tone).toBe(
      'info',
    )
    expect(forecastHeadline(null, NOW).tone).toBe('info')
  })
})

describe('forecastHeadline from both forecasts', () => {
  const sub = (
    name: string,
    weeklyUsed: number,
    weeklyResetsIn: number,
    fiveUsed: number,
    fiveResetsIn: number,
  ): ProfileStatus =>
    profile(name, {
      weekly: weekly(weeklyUsed, weeklyResetsIn),
      fiveHour: { usedFraction: fiveUsed, resetsAt: NOW + fiveResetsIn, lengthMs: FIVE_HOURS_MS },
    })
  const both = (profiles: ProfileStatus[], smoothed = new Map<string, number>()) => [
    poolForecast(profiles, 'weekly', NOW, smoothed, NOW),
    poolForecast(profiles, 'fiveHour', NOW, new Map(), NOW),
  ]

  it('names the weekly gap when every week is full, in either order', () => {
    // The 5-hour forecast is out too, only because it routes to weeks with room.
    const forecasts = both([
      sub('a', 1, 50 * HOUR_MS, 0.1, 3 * HOUR_MS),
      sub('b', 1, 60 * HOUR_MS, 0.1, 3 * HOUR_MS),
    ])
    const headline = 'The pool is out of weekly allowance now, for 2d.'
    expect(forecastHeadline(forecasts, NOW).headline).toBe(headline)
    expect(forecastHeadline([...forecasts].reverse(), NOW).headline).toBe(headline)
  })

  it('names the weekly gap when both are out and some weeks are what is full', () => {
    // b's 5-hour window has room; its full week is what stops it.
    const forecasts = both([
      sub('a', 1, HOUR_MS, 1, 4 * HOUR_MS),
      sub('b', 1, 2 * HOUR_MS, 0.1, 3 * HOUR_MS),
    ])
    const headline = 'The pool is out of weekly allowance now, for 1h.'
    expect(forecastHeadline(forecasts, NOW).headline).toBe(headline)
    expect(forecastHeadline([...forecasts].reverse(), NOW).headline).toBe(headline)
  })
})

describe('review fixes', () => {
  it('says every login has expired rather than that the allowance is gone', () => {
    const expired = { tokenExpiresAt: NOW - MIN }
    const f = poolForecast([profile('a', expired), profile('b', expired)], 'weekly', NOW)
    expect(f).toMatchObject({ clipsAt: null, lasts: 'logins', used: 0.5 })
    expect(forecastHeadline([f], NOW)).toEqual({
      tone: 'error',
      headline: 'No subscription can take work: every login has expired.',
      window: 'weekly',
    })
  })

  it('keeps the last delivered readings while the next range loads or fails', () => {
    const kept = [{ key: 'a', points: [] as Array<[number, number]> }]
    expect(lastReady(kept, { state: 'loading' })).toBe(kept)
    expect(lastReady(kept, { state: 'error', failure: { status: 500, message: 'x' } })).toBe(kept)
    const fresh = [{ key: 'b', points: [] as Array<[number, number]> }]
    expect(lastReady(kept, { state: 'ready', data: fresh, at: 0, failure: null })).toBe(fresh)
    expect(lastReady(null, { state: 'loading' })).toBeNull()
  })

  it('ignores a small dip and counts a real reset', () => {
    const ramp: Array<[number, number]> = Array.from({ length: 25 }, (_, i) => [
      NOW - (24 - i) * HOUR_MS,
      0.3 + 0.01 * i,
    ])
    const clean = burnRate(ramp, NOW, 24 * HOUR_MS) as number
    expect(clean).toBeCloseTo(0.01, 9)
    // One reading 0.01 low: the climb back adds nothing new.
    const dipped = ramp.map(([t, v], i): [number, number] => [t, i === 12 ? v - 0.02 : v])
    expect(burnRate(dipped, NOW, 24 * HOUR_MS)).toBeCloseTo(clean, 9)
  })

  it('reads unsorted and repeated readings like sorted ones, and needs an hour of them', () => {
    const sorted: Array<[number, number]> = [
      [NOW - 3 * HOUR_MS, 0.1],
      [NOW - 2 * HOUR_MS, 0.2],
      [NOW - HOUR_MS, 0.3],
      [NOW, 0.4],
    ]
    const rate = burnRate(sorted, NOW, 24 * HOUR_MS)
    expect(burnRate([...sorted].reverse(), NOW, 24 * HOUR_MS)).toBeCloseTo(rate as number, 9)
    // The same time twice keeps its highest reading, not a fall and a rise.
    const repeated: Array<[number, number]> = [...sorted, [NOW - HOUR_MS, 0.29]]
    expect(burnRate(repeated, NOW, 24 * HOUR_MS)).toBeCloseTo(rate as number, 9)
    expect(
      burnRate(
        [
          [NOW - 1, 0.1],
          [NOW, 0.2],
        ],
        NOW,
        24 * HOUR_MS,
      ),
    ).toBeNull()
  })

  it('measures a young window as at least half an hour old', () => {
    // A minute in, 2% used: not 1.2 per hour.
    const w: QuotaWindow = {
      usedFraction: 0.02,
      resetsAt: NOW + FIVE_HOURS_MS - MIN,
      lengthMs: FIVE_HOURS_MS,
    }
    expect(averageBurnRate(w, NOW)).toBeCloseTo(0.04, 9)
    expect(averageBurnRate({ ...w, usedFraction: 1.3 }, NOW)).toBeCloseTo(2, 9)
  })

  it('names the reporting subscriptions when others have no reading of the window', () => {
    const five: QuotaWindow = { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: FIVE_HOURS_MS }
    const f = poolForecast([profile('a', { fiveHour: five }), profile('b')], 'fiveHour', NOW)
    expect(f).toMatchObject({ counted: 1, unreported: 1, clipsAt: NOW })
    expect(forecastHeadline([f], NOW)).toMatchObject({
      tone: 'warning',
      headline: 'The pool is out of 5-hour capacity now, for 1h (the 1 reporting it).',
    })
  })

  it('sends demand to the subscription that resets soonest first', () => {
    // a takes everything: full at its reset (10h), full again 20h later; then b's 0.1 lasts 2h.
    // Shared evenly it would run out about 2 hours sooner.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.5, 10 * HOUR_MS) }), profile('b', { weekly: weekly(0.9) })],
      'weekly',
      NOW,
      rates({ a: 0.05, b: 0 }),
    )
    expectNear(f.clipsAt, NOW + 32 * HOUR_MS)
  })

  it('catches up on resets far in the past at once', () => {
    const started = performance.now()
    const old = poolForecast(
      [profile('a', { weekly: { usedFraction: 0.5, resetsAt: 0, lengthMs: 1000 } })],
      'weekly',
      NOW,
    )
    expect(performance.now() - started).toBeLessThan(500)
    expect(old.used).toBe(0)
    const lost = poolForecast(
      [profile('a', { weekly: { usedFraction: 0.5, resetsAt: -1e300, lengthMs: 1000 } })],
      'weekly',
      NOW,
    )
    expect(lost.used).toBe(0)
  })

  it('treats a NaN or null smoothed rate as missing, and a stale reading as reset', () => {
    const w = weekly(0.5)
    const averaged = poolForecast([profile('a', { weekly: w })], 'weekly', NOW)
    for (const smooth of [Number.NaN, null]) {
      const f = poolForecast([profile('a', { weekly: w })], 'weekly', NOW, new Map([['a', smooth]]))
      expect(f.burnPerHour).toBeCloseTo(averaged.burnPerHour, 9)
      expect(f.smoothedCount).toBe(0)
    }
    const stale = poolForecast([profile('a', { weekly: weekly(1, -HOUR_MS) })], 'weekly', NOW)
    expect(stale.used).toBe(0)
  })

  it('has no recovery time when no reset is known', () => {
    const f = poolForecast(
      [profile('a', { weekly: { usedFraction: 1, resetsAt: null, lengthMs: WEEK_MS } })],
      'weekly',
      NOW,
    )
    expect(f).toMatchObject({ clipsAt: NOW, recoversAt: null })
  })

  it('runs through several 5-hour windows within the horizon', () => {
    // 0.3 per hour: each window holds 1 allowance for 5h, so every window runs out at 3h20m.
    const five: QuotaWindow = {
      usedFraction: 0,
      resetsAt: NOW + FIVE_HOURS_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    const f = poolForecast([profile('a', { fiveHour: five })], 'fiveHour', NOW, rates({ a: 0.3 }))
    expectNear(f.clipsAt, NOW + (1 / 0.3) * HOUR_MS, 2 * MIN)
    expect(f.recoversAt).toBe(NOW + FIVE_HOURS_MS)
  })

  it('reports expired logins among only those reporting the window as a warning', () => {
    const five: QuotaWindow = {
      usedFraction: 0.5,
      resetsAt: NOW + HOUR_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    const f = poolForecast(
      [profile('a', { fiveHour: five, tokenExpiresAt: NOW - MIN }), profile('b'), profile('c')],
      'fiveHour',
      NOW,
    )
    expect(f).toMatchObject({ lasts: 'logins', counted: 1, unreported: 2 })
    expect(forecastHeadline([f], NOW)).toEqual({
      tone: 'warning',
      headline:
        'Every subscription reporting its 5-hour capacity has an expired login (the 1 reporting it).',
      window: 'fiveHour',
    })
  })

  it('skips a run-out that ended before now when the readings lag', () => {
    // Read 20 minutes ago at 100%; that window reset 5 minutes ago.
    const asOf = NOW - 20 * MIN
    const five: QuotaWindow = { usedFraction: 1, resetsAt: NOW - 5 * MIN, lengthMs: FIVE_HOURS_MS }
    const f = poolForecast([profile('a', { fiveHour: five })], 'fiveHour', asOf, new Map(), NOW)
    expect(f.clipsAt === null || (f.recoversAt ?? Infinity) > NOW).toBe(true)
    expect(f.clipsAt === null || f.clipsAt > NOW - 5 * MIN).toBe(true)
  })

  it('routes the 5-hour forecast by the weekly reset, as claude-master does', () => {
    // a's weekly allowance resets first, so claude-master sends a the work even though b's
    // 5-hour window resets sooner; b's spare 5-hour room then goes unused at its reset.
    const sub = (name: string, weeklyIn: number, fiveUsed: number, fiveIn: number) =>
      profile(name, {
        weekly: { usedFraction: 0.2, resetsAt: NOW + weeklyIn, lengthMs: WEEK_MS },
        fiveHour: { usedFraction: fiveUsed, resetsAt: NOW + fiveIn, lengthMs: FIVE_HOURS_MS },
      })
    const demand = rates({ a: 0.225, b: 0.225 })
    const aFirst = poolForecast(
      [sub('a', 24 * HOUR_MS, 0, 4.9 * HOUR_MS), sub('b', 120 * HOUR_MS, 0.9, 0.5 * HOUR_MS)],
      'fiveHour',
      NOW,
      demand,
    )
    const bFirst = poolForecast(
      [sub('a', 120 * HOUR_MS, 0, 4.9 * HOUR_MS), sub('b', 24 * HOUR_MS, 0.9, 0.5 * HOUR_MS)],
      'fiveHour',
      NOW,
      demand,
    )
    expectNear(aFirst.clipsAt, NOW + 4.47 * HOUR_MS, 2 * MIN)
    expectNear(bFirst.clipsAt, NOW + 4.67 * HOUR_MS, 2 * MIN)
  })

  it('keeps the weekly reserve tier for last, as claude-master does', () => {
    // a (in reserve at 0.95, resets in 2h) is skipped while b is under 0.9: b to 0.9 by 4h, then
    // a (reset, so 0) to 0.9 by 13h, then the reserves, b's (sooner reset) first: 15h.
    // Soonest-first without the tier would run out at 15.5h.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.95, 2 * HOUR_MS) }), profile('b', { weekly: weekly(0.5) })],
      'weekly',
      NOW,
      rates({ a: 0.05, b: 0.05 }),
    )
    expectNear(f.clipsAt, NOW + 15 * HOUR_MS)
  })

  it('routes by each weekly reset as it moves, not the one in the snapshot', () => {
    // a resets first (24h), so it takes the work; after its reset its next one is 192h, so b
    // (48h) goes first, then a again. Neither fills within the week at 0.015 per hour.
    const f = poolForecast(
      [
        profile('a', { weekly: weekly(0, 24 * HOUR_MS) }),
        profile('b', { weekly: weekly(0.3, 48 * HOUR_MS) }),
      ],
      'weekly',
      NOW,
      rates({ a: 0.0075, b: 0.0075 }),
    )
    expect(f).toMatchObject({ clipsAt: null, lasts: 'horizon' })
  })

  it('gives the 5-hour forecast no room in a subscription whose week is used up', () => {
    // claude-master never picks a while its weekly allowance is gone, whatever its 5-hour room:
    // b's 0.1 lasts half an hour, and the first to take work again is b, at its 5-hour reset.
    const f = poolForecast(
      [
        profile('a', {
          weekly: weekly(1, 30 * HOUR_MS),
          fiveHour: { usedFraction: 0, resetsAt: NOW + FIVE_HOURS_MS, lengthMs: FIVE_HOURS_MS },
        }),
        profile('b', {
          weekly: weekly(0.2),
          fiveHour: { usedFraction: 0.9, resetsAt: NOW + FIVE_HOURS_MS, lengthMs: FIVE_HOURS_MS },
        }),
      ],
      'fiveHour',
      NOW,
      rates({ a: 0, b: 0.2 }),
    )
    expectNear(f.clipsAt, NOW + 30 * MIN, 2 * MIN)
    expect(f.recoversAt).toBe(NOW + FIVE_HOURS_MS)
  })

  it('lets a pool that is out now outrank expired logins among only some', () => {
    const forecast = (over: Partial<PoolForecast>): PoolForecast => ({
      window: 'weekly',
      counted: 1,
      unreported: 0,
      smoothedCount: 0,
      used: 1,
      burnPerHour: 0.1,
      clipsAt: null,
      recoversAt: null,
      lasts: null,
      ...over,
    })
    const logins = forecast({ lasts: 'logins', unreported: 1 })
    const out = forecast({ window: 'fiveHour', clipsAt: NOW, recoversAt: NOW + HOUR_MS })
    expect(forecastHeadline([logins, out], NOW)).toMatchObject({
      tone: 'error',
      headline: 'The pool is out of 5-hour capacity now, for 1h.',
    })
    expect(forecastHeadline([logins], NOW).tone).toBe('warning')
  })

  it('headlines the most severe forecast, whatever its position or time', () => {
    const f = (over: Partial<PoolForecast>): PoolForecast => ({
      window: 'weekly',
      counted: 2,
      unreported: 0,
      smoothedCount: 0,
      used: 0.5,
      burnPerHour: 0.1,
      clipsAt: null,
      recoversAt: null,
      lasts: 'horizon',
      ...over,
    })
    const five = { window: 'fiveHour' as const }
    const cases: Array<[string, PoolForecast[], string, string]> = [
      // Every login expired in the window that covers all, though the first covers only some.
      [
        'all logins after partial logins',
        [f({ lasts: 'logins', unreported: 1 }), f({ ...five, lasts: 'logins' })],
        'error',
        'No subscription can take work: every login has expired.',
      ],
      // Out now for all in the second, out now among some in the first: same clip time.
      [
        'out for all after out among some',
        [
          f({ clipsAt: NOW, lasts: null, unreported: 1 }),
          f({ ...five, clipsAt: NOW, lasts: null }),
        ],
        'error',
        'The pool is out of 5-hour capacity now.',
      ],
      [
        'out among some over a later run-out',
        [
          f({ clipsAt: NOW + HOUR_MS, lasts: null }),
          f({ ...five, clipsAt: NOW, lasts: null, unreported: 1, counted: 1 }),
        ],
        'warning',
        'The pool is out of 5-hour capacity now (the 1 reporting it).',
      ],
      [
        'sooner run-out first',
        [
          f({ clipsAt: NOW + 30 * HOUR_MS, lasts: null }),
          f({ ...five, clipsAt: NOW + 2 * HOUR_MS, lasts: null }),
        ],
        'warning',
        'At this pace the pool runs out of its 5-hour capacity in 2h.',
      ],
      [
        'a run-out over partial logins',
        [
          f({ lasts: 'logins', unreported: 1 }),
          f({ ...five, clipsAt: NOW + HOUR_MS, lasts: null }),
        ],
        'warning',
        'At this pace the pool runs out of its 5-hour capacity in 1h.',
      ],
      [
        'partial logins over lasting',
        [f({}), f({ ...five, lasts: 'logins', unreported: 1, counted: 1 })],
        'warning',
        'Every subscription reporting its 5-hour capacity has an expired login (the 1 reporting it).',
      ],
      [
        'lasting over unknown',
        [f({}), f({ ...five, lasts: 'unknown' })],
        'success',
        'At this pace the pool does not run out.',
      ],
      [
        'all unknown',
        [f({ lasts: 'unknown' }), f({ ...five, lasts: 'unknown' })],
        'info',
        'No subscription has reported its usage yet.',
      ],
    ]
    for (const [name, forecasts, tone, headline] of cases) {
      expect({ name, ...forecastHeadline(forecasts, NOW) }).toMatchObject({ name, tone, headline })
      // Order does not matter.
      expect({ name, ...forecastHeadline([...forecasts].reverse(), NOW) }).toMatchObject({
        name,
        tone,
        headline,
      })
    }
  })

  it('lets a week that resets inside the 5-hour horizon take work again', () => {
    // a's week is full for an hour; then a takes work with all its 5-hour room, so b's 0.4
    // never has to last on its own.
    const f = poolForecast(
      [
        profile('a', {
          weekly: weekly(1, HOUR_MS),
          fiveHour: { usedFraction: 0, resetsAt: NOW + FIVE_HOURS_MS, lengthMs: FIVE_HOURS_MS },
        }),
        profile('b', {
          weekly: weekly(0.2),
          fiveHour: { usedFraction: 0.6, resetsAt: NOW + FIVE_HOURS_MS, lengthMs: FIVE_HOURS_MS },
        }),
      ],
      'fiveHour',
      NOW,
      rates({ a: 0, b: 0.2 }),
    )
    expect(f).toMatchObject({ clipsAt: null, lasts: 'horizon' })
  })

  it('takes work again only after the later of two full windows resets', () => {
    const f = poolForecast(
      [
        profile('a', {
          weekly: weekly(1, 3 * HOUR_MS),
          fiveHour: { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: FIVE_HOURS_MS },
        }),
      ],
      'fiveHour',
      NOW,
    )
    expect(f).toMatchObject({ clipsAt: NOW, recoversAt: NOW + 3 * HOUR_MS })
  })

  it('orders as claude-master: reserve tier, read week, soonest reset, configured order', () => {
    const slot = (index: number, used: number, resetsAt: number | null, known = true): Slot => {
      const weekly = { used, resetsAt, lengthMs: WEEK_MS, known }
      return { quota: weekly, weekly, index }
    }
    const order = (...slots: Slot[]) => [...slots].sort(routeOrder).map((s) => s.index)
    // Under the reserve tier first, whatever the reset.
    expect(order(slot(0, 0.95, NOW + HOUR_MS), slot(1, 0.5, NOW + 100 * HOUR_MS))).toEqual([1, 0])
    // A read week before an unread one that resets sooner.
    expect(order(slot(0, 0, NOW + HOUR_MS, false), slot(1, 0.2, NOW + 120 * HOUR_MS))).toEqual([
      1, 0,
    ])
    // Soonest reset; an unknown reset after a known one.
    expect(
      order(slot(0, 0.2, null), slot(1, 0.2, NOW + 120 * HOUR_MS), slot(2, 0.2, NOW + HOUR_MS)),
    ).toEqual([2, 1, 0])
    // Otherwise the configured order.
    expect(order(slot(1, 0.2, null), slot(0, 0.2, null))).toEqual([0, 1])
  })
})
