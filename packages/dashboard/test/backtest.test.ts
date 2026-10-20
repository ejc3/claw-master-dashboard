import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  burnRate,
  type EpochMs,
  forecastProfiles,
  HOUR_MS,
  type PoolGaps,
  type ProfileStatus,
  poolGaps,
  poolPace,
  poolRates,
  WEEKLY_SMOOTHING_MS,
} from '../src/core/index'
import { readingsQuery } from '../src/react/queries'

// The pool's own history, 2026-10-09 to 10-20, with the subscriptions renamed: both windows' used
// shares every 10 minutes (what the page reads), the snapshot at each start point (every 6 hours
// from 10-11), and how long no subscription could take work in the 24 and 48 hours after it,
// measured from 5-minute readings, with whether a subscription joined in that time.
interface Fixture {
  stepMs: number
  startMs: EpochMs
  subscriptions: Record<string, { weekly: Array<number | null>; five: Array<number | null> }>
  points: Array<{
    t0: EpochMs
    asOf: EpochMs
    profiles: ProfileStatus[]
    down24?: number
    added24?: boolean
  }>
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('./support/backtest-2026-10.json', import.meta.url), 'utf8'),
)

/** What the page's readings query at t0 returns: its range, start inclusive, end exclusive. */
function series(kind: 'weekly' | 'five', t0: EpochMs) {
  const { start, end } = readingsQuery(t0).range
  return Object.entries(fixture.subscriptions).map(([key, s]) => ({
    key,
    points: s[kind].flatMap((v, i): Array<[EpochMs, number]> => {
      const t = fixture.startMs + i * fixture.stepMs
      return v === null || t < start || t >= end ? [] : [[t, v]]
    }),
  }))
}

/** Hours without a subscription to take work in the day after t0, as the forecast has it. */
function downInDay(g: PoolGaps, t0: EpochMs): number {
  const end = t0 + 24 * HOUR_MS
  let ms = 0
  for (const gap of g.gaps)
    ms += Math.max(0, Math.min(gap.end ?? end, end) - Math.max(gap.start, t0))
  return ms / HOUR_MS
}

/**
 * The page's forecast from a start point, at the pool's pace (poolPace) or, `pooled` false, at the
 * pace the subscriptions measure apart: the sum of each one's smoothed weekly rate, and each 5-hour
 * window's average so far.
 */
function forecastAt(point: Fixture['points'][number], pooled: boolean): number {
  const { t0, asOf } = point
  // As the page: the readings its query returns, measured at the query's end.
  const weekly = series('weekly', t0)
  const five = series('five', t0)
  const end = readingsQuery(t0).range.end
  const smoothed = new Map(weekly.map((s) => [s.key, burnRate(s.points, end, WEEKLY_SMOOTHING_MS)]))
  const profiles = forecastProfiles(point.profiles, t0)
  const measured = poolGaps(profiles, asOf, smoothed, t0).pace
  const pace = pooled ? poolPace(measured, poolRates(weekly, five, end)) : measured
  return downInDay(poolGaps(profiles, Math.max(asOf, t0), smoothed, t0, false, pace), t0)
}

function score(pooled: boolean) {
  // A subscription joining in the day changes the capacity the forecast could not know of.
  const points = fixture.points.filter((p) => p.down24 !== undefined && p.added24 === false)
  let absError = 0
  let caught = 0
  let outages = 0
  let falseAlarms = 0
  for (const p of points) {
    const actual = p.down24 as number
    const forecast = forecastAt(p, pooled)
    absError += Math.abs(forecast - actual)
    if (actual >= 1) {
      outages++
      if (forecast >= 1) caught++
    } else if (forecast >= 1) {
      falseAlarms++
    }
  }
  return { points: points.length, mae: absError / points.length, caught, outages, falseAlarms }
}

describe('the forecast against the pool’s own October history', () => {
  it("reads what the page's query returns: none of the bucket still filling, nothing later", () => {
    // Five minutes into a 10-minute step: the range ends at the step, exclusive.
    const t0 = (fixture.points[4]?.t0 as EpochMs) + 5 * 60_000
    const { start, end } = readingsQuery(t0).range
    expect(end).toBe(t0 - 5 * 60_000)
    const times = series('weekly', t0).flatMap((s) => s.points.map(([t]) => t))
    expect(times.length).toBeGreaterThan(0)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(start)
    expect(Math.max(...times)).toBe(end - fixture.stepMs)
  })

  it('has the points it was measured on', () => {
    const s = score(true)
    expect(s.points).toBe(24)
    expect(s.outages).toBe(5)
  })

  it('forecasts the next day’s downtime within about an hour, with few false alarms', () => {
    // Measured when the model was chosen: 0.83 hours off on average, 4 of 5 outages, 1 false alarm.
    const s = score(true)
    expect(s.mae).toBeLessThan(1.5)
    expect(s.caught).toBeGreaterThanOrEqual(4)
    expect(s.falseAlarms).toBeLessThanOrEqual(2)
  })

  it('beats the pace measured per subscription and per window (1.31 hours off, 3 false alarms)', () => {
    const pool = score(true)
    const apart = score(false)
    expect(pool.mae).toBeLessThan(apart.mae - 0.3)
    expect(pool.falseAlarms).toBeLessThan(apart.falseAlarms)
  })
})
