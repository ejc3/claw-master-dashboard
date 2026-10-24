import { describe, expect, it } from 'vitest'
import { HOUR_MS } from '../src/core'
import {
  axisTime,
  foldSeries,
  niceMax,
  OTHER_COLOR,
  seriesColors,
  timeTicks,
  valueTicks,
} from '../src/react/LineChart'
import { sharedPeak, sparkBars, sparkHeights } from '../src/react/Sparkline'

const NOW = Date.UTC(2026, 9, 9, 12, 7)

describe('timeTicks', () => {
  it('puts at most the asked number of ticks on round local hours', () => {
    const first = NOW - 24 * HOUR_MS
    for (const most of [3, 6]) {
      const ticks = timeTicks(first, NOW, most)
      expect(ticks.length).toBeGreaterThan(0)
      expect(ticks.length).toBeLessThanOrEqual(most + 1)
      const offset = new Date(first).getTimezoneOffset() * 60_000
      for (const t of ticks) {
        expect((t - offset) % HOUR_MS).toBe(0)
        expect(t >= first && t <= NOW).toBe(true)
      }
    }
  })

  it('spaces a fortnight out on a narrow chart, and leaves a week as it was', () => {
    const fortnight = timeTicks(NOW - 7 * 24 * HOUR_MS, NOW + 7 * 24 * HOUR_MS, 3)
    expect(fortnight.length).toBeLessThanOrEqual(4)
    expect((fortnight[1] ?? 0) - (fortnight[0] ?? 0)).toBe(4 * 24 * HOUR_MS)
    // A week, narrow or wide: every two days, as before.
    for (const most of [3, 6]) {
      const week = timeTicks(NOW - 7 * 24 * HOUR_MS, NOW, most)
      expect((week[1] ?? 0) - (week[0] ?? 0)).toBe(2 * 24 * HOUR_MS)
    }
    // A fortnight on a wide chart: every two days too.
    const wide = timeTicks(NOW - 7 * 24 * HOUR_MS, NOW + 7 * 24 * HOUR_MS, 6)
    expect((wide[1] ?? 0) - (wide[0] ?? 0)).toBe(2 * 24 * HOUR_MS)
  })

  it('stays on the local hour across a daylight-saving change', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      // 2026-03-08: clocks in New York go from 02:00 to 03:00.
      const first = Date.UTC(2026, 2, 7, 17) // 12:00 local, Mar 7
      const last = Date.UTC(2026, 2, 9, 4) // 00:00 local, Mar 9
      const ticks = timeTicks(first, last, 6)
      expect(ticks.length).toBeGreaterThan(2)
      for (const t of ticks) {
        const d = new Date(t)
        expect(d.getMinutes()).toBe(0)
        expect(d.getHours() % 6).toBe(0)
      }
    } finally {
      process.env.TZ = tz
    }
  })

  it('stays on the hour across a 30-minute daylight-saving change', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Australia/Lord_Howe'
    try {
      const ticks = timeTicks(Date.UTC(2026, 9, 3, 15), Date.UTC(2026, 9, 4, 14, 55), 6)
      expect(ticks.length).toBeGreaterThan(2)
      for (const [i, t] of ticks.entries()) {
        expect(new Date(t).getMinutes()).toBe(0)
        if (i > 0) expect(t).toBeGreaterThan(ticks[i - 1] as number)
      }
    } finally {
      process.env.TZ = tz
    }
  })

  it('is empty for an empty range', () => {
    expect(timeTicks(NOW, NOW, 5)).toEqual([])
  })
})

describe('series helpers', () => {
  const s = (key: string, v: number) => ({
    key,
    points: [[0, v] as [number, number], [1, v] as [number, number]],
  })

  it('folds the smallest series past the limit into Other, keeping the total', () => {
    const series = ['a', 'b', 'c', 'd'].map((k, i) => s(k, i + 1))
    const folded = foldSeries(series, 3)
    expect(folded.map((x) => x.key)).toEqual(['d', 'c', 'Other'])
    expect(folded.at(-1)?.points).toEqual([
      [0, 3],
      [1, 3],
    ])
    expect(foldSeries(series, 4)).toBe(series)
  })

  it('colors by name across the known set, so a missing series repaints no other', () => {
    const known = ['alpha', 'bravo', 'charlie']
    const everything = seriesColors(known)
    const withoutCharlie = seriesColors(known, ['alpha', 'bravo'])
    expect(withoutCharlie.get('bravo')).toBe(everything.get('bravo'))
    expect(everything.get('alpha')).toBe('var(--cmd-series-1)')
    expect(seriesColors(['charlie', 'bravo', 'alpha'])).toEqual(everything)
  })

  it('keeps Other neutral and out of the slots, and never shows two lines in one color', () => {
    const known = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
    const with8 = seriesColors(known, ['a', 'b', 'c'])
    const withOther = seriesColors(known, ['a', 'b', 'c', 'Other'])
    expect(withOther.get('a')).toBe(with8.get('a'))
    expect(withOther.get('Other')).toBe(OTHER_COLOR)
    // 'i' would share slot 1 with 'a' (nine known); shown together they differ.
    const both = seriesColors(known, ['a', 'i'])
    expect(both.get('a')).not.toBe(both.get('i'))
  })
})

describe('axis', () => {
  it('keeps count axes on whole numbers', () => {
    expect(niceMax(2.5, true)).toBe(5)
    expect(niceMax(2.5, false)).toBe(2.5)
    expect(niceMax(180, true)).toBe(200)
    expect(valueTicks(5, true)).toEqual([0, 5])
    expect(valueTicks(200, true)).toEqual([0, 100, 200])
    expect(valueTicks(0.05, false)).toEqual([0, 0.025, 0.05])
  })
})

describe('sparkline scale', () => {
  it('lets the busiest row reach full height on noisy data', () => {
    // 288 five-minute points whose single-point spike (200) far exceeds their typical value (10):
    // a shared scale estimated from the largest point would leave every bar short.
    const noisy: Array<[number, number]> = Array.from({ length: 288 }, (_, i) => [
      i * 300_000,
      i === 7 ? 200 : 10,
    ])
    const quiet: Array<[number, number]> = noisy.map(([t]) => [t, 2])
    const peak = Math.max(...[noisy, quiet].flatMap((points) => sparkBars(points)))
    expect(Math.max(...sparkHeights(sparkBars(noisy), peak))).toBeCloseTo(26, 9)
    // The quieter row compares by height on the same scale.
    expect(Math.max(...sparkHeights(sparkBars(quiet), peak))).toBeLessThan(26 / 4)
  })

  it('sums every point into at most 24 bars and keeps a nonzero bar visible', () => {
    const points: Array<[number, number]> = Array.from({ length: 50 }, (_, i) => [i, 1])
    const bars = sparkBars(points)
    expect(bars).toHaveLength(24)
    expect(bars.reduce((a, b) => a + b, 0)).toBe(50)
    expect(sparkHeights([0, 0.001, 100])).toEqual([0, 1.5, 26])
  })
})

describe('sharedPeak', () => {
  it('takes the tallest bar of rows that draw a sparkline only', () => {
    const drawn: Array<[number, number]> = [
      [0, 1],
      [1, 2],
    ]
    // One point draws no sparkline: its 50 must not shrink the drawn row's bars.
    expect(sharedPeak([{ points: drawn }, { points: [[0, 50]] }])).toBe(2)
    expect(sharedPeak([])).toBe(0)
  })
})

describe('axisTime', () => {
  it("shortens tick labels: a midnight to its day (today's to Today), an hour on the hour without minutes", () => {
    expect(axisTime('Tue 12:00 AM')).toBe('Tue')
    expect(axisTime('Oct 30, 12:00 AM')).toBe('Oct 30')
    expect(axisTime('6:00 PM')).toBe('6 PM')
    expect(axisTime('Sun 12:00 PM')).toBe('Sun 12 PM')
    expect(axisTime('12:00 AM')).toBe('Today')
    expect(axisTime('6:30 PM')).toBe('6:30 PM')
  })
})
