import { describe, expect, it } from 'vitest'
import {
  FIVE_HOURS_MS,
  GAPS_HORIZON_MS,
  gapsHeadline,
  HOUR_MS,
  type PoolGaps,
  type ProfileStatus,
  poolGaps,
  TRACE_STEP_MS,
  WEEK_MS,
} from '../src/core/index'

const NOW = Date.UTC(2026, 9, 9, 12)
const H = HOUR_MS
const M = 60_000

/** A subscription: its weekly and 5-hour used shares and resets (null: not read). */
function sub(
  name: string,
  weekly: [number, number] | null,
  five: [number, number | null] | null,
  extra: Partial<ProfileStatus> = {},
): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly:
      weekly === null
        ? { usedFraction: null, resetsAt: null, lengthMs: WEEK_MS }
        : { usedFraction: weekly[0], resetsAt: NOW + weekly[1], lengthMs: WEEK_MS },
    fiveHour:
      five === null
        ? null
        : {
            usedFraction: five[0],
            resetsAt: five[1] === null ? null : NOW + five[1],
            lengthMs: FIVE_HOURS_MS,
          },
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...extra,
  }
}

const rates = (entries: Record<string, number>) => new Map(Object.entries(entries))
const hours = (g: PoolGaps) =>
  g.gaps.map((gap) => ({
    start: (gap.start - NOW) / H,
    end: gap.end === null ? null : (gap.end - NOW) / H,
    endsWith: gap.endsWith,
  }))
/** The status line and its facts, as one string: "headline | fact | fact". */
/** The first gap's part of the headline: the day's total after it has tests of its own. */
const firstGap = (text: string) => text.replace(/ and [^|]+ of the next 24 hours/, '')
const headline = (g: PoolGaps) => {
  const h = gapsHeadline(g, NOW)
  return firstGap([h.headline, ...h.facts].join(' | '))
}

describe('poolGaps: both windows in one simulation', () => {
  it('a pool much like a real one: 5-hour gaps soon, then a week of days', () => {
    // One subscription with room in its week and little in its 5-hour window, one with room in
    // its week and no 5-hour reading, two whose weeks are used up.
    const g = poolGaps(
      [
        sub('a', [0.27, 81 * H], null),
        sub('b', [0.47, 158 * H], [0.77, 3.75 * H]),
        sub('c', [1, 95 * H], null),
        sub('d', [1, 58 * H], null),
      ],
      NOW,
      rates({ a: 0.03, b: 0.06, c: 0.03, d: 0.03 }),
    )
    // a's 5-hour window, unread, starts with its first work and fills, then b's.
    expect(hours(g).slice(0, 3)).toEqual([
      { start: 2, end: 3.75, endsWith: 'fiveHour' },
      { start: 7 + 2 / 60, end: 8 + 46 / 60, endsWith: 'fiveHour' },
      { start: 11 + 56 / 60, end: 58, endsWith: 'weekly' },
    ])
    expect(headline(g)).toBe('Runs out in 2h for 1h 45m')
    expect(gapsHeadline(g, NOW).tone).toBe('warning')
  })

  it('every week full: out now until the first week resets, whatever the 5-hour windows', () => {
    const g = poolGaps(
      [sub('a', [1, 50 * H], [0.1, 3 * H]), sub('b', [1, 60 * H], [0.1, 3 * H])],
      NOW,
    )
    expect(hours(g)[0]).toEqual({ start: 0, end: 50, endsWith: 'weekly' })
    expect(headline(g)).toMatch(/^Out now · back in 2d$/)
    expect(gapsHeadline(g, NOW).tone).toBe('error')
  })

  it('uses up no week during a 5-hour gap', () => {
    // Weeks nearly full, 5-hour windows half used: the 5-hour windows go first, and the weeks
    // run out only after enough working hours between 5-hour gaps.
    const g = poolGaps(
      [sub('a', [0.97, 50 * H], [0.5, 4.5 * H]), sub('b', [0.97, 60 * H], [0.5, 4.5 * H])],
      NOW,
      rates({ a: 0.01, b: 0.01 }),
    )
    expect(hours(g).slice(0, 3)).toEqual([
      { start: 0.5, end: 4.5, endsWith: 'fiveHour' },
      { start: 5.5, end: 9.5, endsWith: 'fiveHour' },
      { start: 10.5, end: 14.5, endsWith: 'fiveHour' },
    ])
    expect(hours(g).find((gap) => gap.endsWith === 'weekly')).toEqual({
      start: 15 + 16 / 60,
      end: 50,
      endsWith: 'weekly',
    })
    expect(headline(g)).toBe('Runs out in 30m for 4h')
  })

  it('has no 5-hour gap inside a weekly one', () => {
    const g = poolGaps(
      [sub('a', [0.99, 50 * H], [0.15, 4.5 * H]), sub('b', [0.99, 60 * H], [0.15, 4.5 * H])],
      NOW,
      rates({ a: 0.01, b: 0.01 }),
    )
    expect(hours(g)[0]).toEqual({ start: 1, end: 50, endsWith: 'weekly' })
    expect((hours(g)[1]?.start ?? Infinity) >= 50).toBe(true)
    expect(headline(g)).toBe('Runs out in 1h for 2d')
  })

  it('keeps the others working through one subscription’s gap', () => {
    // a is out of both windows; b, with no 5-hour reading, works on until its week is full.
    const g = poolGaps(
      [sub('a', [1, 50 * H], [1, 3 * H]), sub('b', [0.9, 60 * H], null)],
      NOW,
      rates({ a: 0, b: 0.1 }),
    )
    expect(hours(g)[0]).toEqual({ start: 1, end: 50, endsWith: 'weekly' })
  })

  it('ends a gap at the reset that lets work flow, not the first reset', () => {
    // The week resets in an hour, but the 5-hour window is full for four.
    const one = poolGaps([sub('a', [1, H], [1, 4 * H])], NOW)
    expect(hours(one)[0]).toEqual({ start: 0, end: 4, endsWith: 'fiveHour' })
    expect(headline(one)).toBe('Out now · back in 4h')
    // With a second subscription whose week resets in two hours, that ends it.
    const two = poolGaps([sub('a', [1, H], [1, 4 * H]), sub('b', [1, 2 * H], [0.1, 3 * H])], NOW)
    expect(hours(two)[0]).toEqual({ start: 0, end: 2, endsWith: 'weekly' })
  })

  it('opens a 5-hour window with work when none is open, and closes it at its reset', () => {
    // b reports no window open (nothing used, no reset time): it opens at b's first work, so
    // the gap lasts until that window resets, not until a week does.
    const g = poolGaps(
      [sub('a', [1, 72 * H], [0.5, 4 * H]), sub('b', [0.2, 100 * H], [0, null])],
      NOW,
      rates({ a: 0.001, b: 0.001 }),
    )
    expect(hours(g)[0]).toEqual({ start: 2, end: 5, endsWith: 'fiveHour' })
    expect(headline(g)).toBe('Runs out in 2h for 3h')
    // a's window resets five minutes in, while its week is full: the next opens when work
    // resumes at 4h, not on the old window's five-hour clock.
    const c = sub('c', [0.3, 100 * H], [0.5, H], { tokenExpiresAt: NOW - H })
    const after = poolGaps(
      [sub('a', [1, 4 * H], [0.9, 5 * M]), c],
      NOW,
      rates({ a: 0.001, c: 0.001 }),
    )
    expect(hours(after)[0]).toEqual({ start: 0, end: 4, endsWith: 'weekly' })
    expect(hours(after)[1]?.end).toBe(9)
  })

  it('lists every gap in the horizon, so a weekly one after many 5-hour ones is found', () => {
    const subs = [0, 1, 2, 3].map((i) =>
      sub(`s${i}`, [0.6, (150 + i) * H], [0.8, (1.25 * (i + 1) - 0.01) * H]),
    )
    const g = poolGaps(subs, NOW, new Map(subs.map((s) => [s.profile, 0.012])))
    expect(g.gaps.length).toBeGreaterThan(50)
    // The weekly gap of days after them is in the list (and on the charts).
    expect(hours(g).some((gap) => gap.endsWith === 'weekly' && gap.start > 4 * 24)).toBe(true)
  })

  it('finds a run-out of a few minutes, as the 5-hour card does', () => {
    const g = poolGaps([sub('a', [0.1, 100 * H], [0.99, 4.5 * M])], NOW)
    expect(headline(g)).toBe('Runs out in 4m for 30s')
  })

  it('after a short weekly gap, names the next weekly one that lasts longer, past 5-hour ones', () => {
    const g = poolGaps(
      [sub('a', [1, 10 * M], [0, M]), sub('b', [1, 72 * H], [0.5, 4 * H])],
      NOW,
      rates({ a: 0.02, b: 0.02 }),
    )
    expect(headline(g)).toBe('Out now · back in 10m')
  })

  it('keeps a full 5-hour window closed until its reset, from the readings time', () => {
    // Read at 11:55 (from), now is 12:00; the full window resets at 11:59:30. Work can start only
    // then, so the week is used for 30 seconds before now, not five minutes.
    const from = NOW - 5 * M
    const profile = {
      ...sub('a', [0.99, 48 * H], null),
      fiveHour: { usedFraction: 1, resetsAt: NOW - 30_000, lengthMs: FIVE_HOURS_MS },
    }
    const g = poolGaps([profile], from, rates({ a: 0.6 }), NOW)
    // The week (1% left at 60% an hour) lasts a minute of work: it runs out after now.
    expect(g.gaps[0]?.start ?? 0).toBeGreaterThan(NOW)
    expect(g.gaps[0]?.endsWith).toBe('weekly')
  })

  it('keeps a rate-limited subscription out of work until the limit ends', () => {
    const g = poolGaps([sub('a', [0.3, 100 * H], null, { rateLimitedUntil: NOW + 2 * H })], NOW)
    expect(hours(g)[0]).toEqual({ start: 0, end: 2, endsWith: 'rateLimit' })
    expect(headline(g)).toBe('Out now · back in 2h')
  })

  it('a pool hit by its 5-hour limits: out within minutes, not "two can take work"', () => {
    // One near the end of its 5-hour window, one whose window is full (its last reading kept),
    // two with their weeks used up, one rate-limited.
    const g = poolGaps(
      [
        sub('a', [0.52, 78 * H], [0.96, 3.77 * H]),
        sub('b', [0.54, 155 * H], [1, H]),
        sub('c', [1, 92 * H], null),
        sub('d', [1, 55 * H], null),
        sub('e', [0.27, 107 * H], null, { rateLimitedUntil: NOW + 146 * M }),
      ],
      NOW,
      rates({ a: 0.05, b: 0.05, c: 0.05, d: 0.05, e: 0.05 }),
    )
    expect(hours(g)[0]).toEqual({ start: 4 / 60, end: 1, endsWith: 'fiveHour' })
    expect(headline(g)).toMatch(/^Runs out in 4m for 56m$/)
  })

  it('skips a gap that has ended by now, and starts from the readings', () => {
    // Read three hours ago: a week full then, reset an hour ago.
    const from = NOW - 3 * H
    const g = poolGaps(
      [
        {
          ...sub('a', [1, 0], null),
          weekly: { usedFraction: 1, resetsAt: NOW - H, lengthMs: WEEK_MS },
        },
      ],
      from,
      new Map(),
      NOW,
    )
    expect(g.gaps.every((gap) => gap.end === null || gap.end > NOW)).toBe(true)
    expect(g.gaps[0]?.start ?? Infinity).toBeGreaterThan(NOW - H)
  })

  it('reads idle, unknown and expired logins', () => {
    expect(poolGaps([sub('a', [0.2, 50 * H], [0.1, 3 * H])], NOW, rates({ a: 0 })).lasts).toBe(
      'horizon',
    )
    expect(poolGaps([sub('a', [0, 50 * H], [0, 3 * H])], NOW, rates({ a: 0 })).lasts).toBe('idle')
    expect(poolGaps([sub('a', null, [0.5, 3 * H])], NOW).lasts).toBe('unknown')
    expect(poolGaps([sub('a', [0.5, 50 * H], null, { tokenExpiresAt: NOW - 1 })], NOW).lasts).toBe(
      'logins',
    )
  })
})

describe('when the pool runs out and for how long: the matrix', () => {
  // Each row: a pool, then the first gap worked out by hand (hours from now): when no
  // subscription can take work, and when the first one can again, which needs room in its week
  // and its 5-hour window and no rate limit. Then the headline that says it.
  type Row = {
    name: string
    profiles: ProfileStatus[]
    rates?: Record<string, number>
    from?: number
    gap: { start: number; end: number | null; endsWith: string | null } | null
    headline: string
  }
  const rows: Row[] = [
    {
      name: 'week used up, 5-hour room: out until the week resets',
      profiles: [sub('a', [1, 10 * H], [0.2, 3 * H])],
      gap: { start: 0, end: 10, endsWith: 'weekly' },
      headline: 'Out now · back in 10h',
    },
    {
      name: '5-hour used up, week room: out until the 5-hour window resets',
      profiles: [sub('a', [0.3, 100 * H], [1, 2 * H])],
      gap: { start: 0, end: 2, endsWith: 'fiveHour' },
      headline: 'Out now · back in 2h',
    },
    {
      name: 'both used up, the week resets first: back when the 5-hour window does',
      profiles: [sub('a', [1, H], [1, 4 * H])],
      gap: { start: 0, end: 4, endsWith: 'fiveHour' },
      headline: 'Out now · back in 4h',
    },
    {
      name: 'both used up, the 5-hour window resets first: back when the week does',
      profiles: [sub('a', [1, 4 * H], [1, H])],
      gap: { start: 0, end: 4, endsWith: 'weekly' },
      headline: 'Out now · back in 4h',
    },
    {
      name: 'rate limited with room in both: back when the rate limit ends',
      profiles: [sub('a', [0.3, 100 * H], [0.2, 3 * H], { rateLimitedUntil: NOW + 2 * H })],
      gap: { start: 0, end: 2, endsWith: 'rateLimit' },
      headline: 'Out now · back in 2h',
    },
    {
      name: 'rate limited, and the week used up for longer: back when the week resets',
      profiles: [sub('a', [1, 5 * H], [0.2, 3 * H], { rateLimitedUntil: NOW + 2 * H })],
      gap: { start: 0, end: 5, endsWith: 'weekly' },
      headline: 'Out now · back in 5h',
    },
    {
      name: 'week used up with no reset time read: out with no end known',
      profiles: [
        {
          ...sub('a', [1, H], [0.2, 3 * H]),
          weekly: { usedFraction: 1, resetsAt: null, lengthMs: WEEK_MS },
        },
      ],
      gap: { start: 0, end: null, endsWith: null },
      headline: 'Out now · no reset time known',
    },
    {
      name: 'two out for different reasons: back when the first of them can work',
      profiles: [sub('a', [1, 10 * H], [0.2, 3 * H]), sub('b', [0.3, 100 * H], [1, 3 * H])],
      gap: { start: 0, end: 3, endsWith: 'fiveHour' },
      headline: 'Out now · back in 3h',
    },
    {
      name: 'one out, one with room and nothing used: never runs out',
      profiles: [sub('a', [1, 10 * H], [0.2, 3 * H]), sub('b', [0.3, 100 * H], [0, null])],
      rates: { a: 0, b: 0 },
      gap: null,
      headline: "Won't run out in the next 7 days",
    },
    {
      name: 'a subscription with an expired login does not count as room',
      profiles: [
        sub('a', [0.1, 100 * H], [0, null], { tokenExpiresAt: NOW - 1 }),
        sub('b', [1, 6 * H], [0.2, 3 * H]),
      ],
      gap: { start: 0, end: 6, endsWith: 'weekly' },
      headline: 'Out now · back in 6h',
    },
    {
      name: 'the week runs out at its pace: from an hour on, until the week resets',
      // 10% left at 10% of a week an hour; no 5-hour reading, so no 5-hour use measured.
      profiles: [sub('a', [0.9, 50 * H], null)],
      rates: { a: 0.1 },
      gap: { start: 1, end: 50, endsWith: 'weekly' },
      headline: 'Runs out in 1h for 2d',
    },
    {
      name: 'the 5-hour window runs out at its pace: from an hour on, until it resets',
      // Half used an hour into the window: half an hour's worth an hour, half left.
      profiles: [sub('a', [0.1, 100 * H], [0.5, 4 * H])],
      rates: { a: 0 },
      gap: { start: 1, end: 4, endsWith: 'fiveHour' },
      headline: 'Runs out in 1h for 3h',
    },
    {
      name: 'the week resets while the 5-hour window is still full: back at the 5-hour reset',
      profiles: [sub('a', [1, 2 * H], [1, 3 * H]), sub('b', [1, 5 * H], [0, null])],
      gap: { start: 0, end: 3, endsWith: 'fiveHour' },
      headline: 'Out now · back in 3h',
    },
    {
      name: 'a gap over before now (readings from earlier) is not reported',
      // Read three hours ago: the week was full until an hour ago; nothing used since.
      from: NOW - 3 * H,
      profiles: [
        {
          ...sub('a', [1, 0], [0, null]),
          weekly: { usedFraction: 1, resetsAt: NOW - H, lengthMs: WEEK_MS },
        },
      ],
      rates: { a: 0 },
      gap: null,
      headline: "Won't run out in the next 7 days",
    },
  ]
  for (const row of rows) {
    it(row.name, () => {
      const g = poolGaps(row.profiles, row.from ?? NOW, rates(row.rates ?? {}), NOW)
      const [first] = g.gaps
      if (row.gap === null) {
        expect(first).toBeUndefined()
      } else {
        if (first === undefined) throw new Error('no gap')
        // Within a step of the hand-worked times: the simulation moves two minutes at a time.
        expect(Math.abs(first.start - (NOW + row.gap.start * H))).toBeLessThanOrEqual(2 * M)
        if (row.gap.end === null) expect(first.end).toBeNull()
        else expect(first.end).toBe(NOW + row.gap.end * H)
        expect(first.endsWith).toBe(row.gap.endsWith)
      }
      expect(firstGap(gapsHeadline(g, NOW).headline)).toBe(row.headline)
    })
  }
})

describe('allowance left on the table at weekly resets', () => {
  it('notes what each week still has unused when it resets, after now', () => {
    // 30% used, resetting in 10 hours, at 1% of a week an hour: 40% used at the reset, 60% lost.
    const g = poolGaps([sub('a', [0.3, 10 * H], null)], NOW, rates({ a: 0.01 }))
    expect(g.unusedAtReset[0]?.profile).toBe('a')
    expect(g.unusedAtReset[0]?.at).toBe(NOW + 10 * H)
    expect(g.unusedAtReset[0]?.unused).toBeCloseTo(0.6, 2)
  })

  it('notes nothing for a week used up by its reset, or a reset already past', () => {
    const full = poolGaps([sub('a', [1, 10 * H], null)], NOW, rates({ a: 0 }))
    expect(full.unusedAtReset.filter((r) => r.at === NOW + 10 * H)).toEqual([])
    const before = poolGaps(
      [
        {
          ...sub('a', [0.5, 0], null),
          weekly: { usedFraction: 0.5, resetsAt: NOW - H, lengthMs: WEEK_MS },
        },
      ],
      NOW - 3 * H,
      rates({ a: 0 }),
      NOW,
    )
    expect(before.unusedAtReset.every((r) => r.at > NOW)).toBe(true)
  })

  it('with no more use, every week is lost whole but what is used', () => {
    const g = poolGaps([sub('a', [0.3, 10 * H], null)], NOW, rates({ a: 0.01 }), NOW, true)
    expect(g.unusedAtReset[0]?.unused).toBeCloseTo(0.7, 6)
  })
})

describe('poolGaps capacity trace', () => {
  it('has a point at now, so a reset since the last sample shows at once', () => {
    // a's 5-hour window is used up and resets 2 minutes after the reading; now is a minute later,
    // between the 10-minute samples.
    const now = NOW + 3 * 60_000
    const g = poolGaps([sub('a', [0.5, 50 * H], [1, 2 * 60_000])], NOW, rates({ a: 0 }), now)
    expect(g.trace.map((p) => p.at).slice(0, 3)).toEqual([NOW, now, NOW + 10 * 60_000])
    expect(g.trace[0]?.fiveHour).toBe(0)
    // Alpha's whole window, less the little simulated since the reset, as far as its half-used
    // week lets it be used.
    expect(g.trace[1]?.fiveHour).toBeGreaterThan(0.45)
    expect(g.trace[1]?.fiveHour).toBeLessThanOrEqual(0.5)
    // A reset due after now does not show at now, even inside the same simulation step: a
    // half-used window resetting 90 seconds in still reads about half left at 60 seconds.
    const early = poolGaps(
      [sub('a', [0.5, 50 * H], [0.5, 90_000])],
      NOW,
      rates({ a: 0 }),
      NOW + 60_000,
    )
    expect(early.clock).toBe(NOW + 60_000)
    expect(early.trace.find((p) => p.at === NOW + 60_000)?.fiveHour).toBeLessThan(0.6)
    // A now on a sample is that sample, not a second point.
    const onGrid = poolGaps(
      [sub('a', [0.5, 50 * H], null)],
      NOW,
      rates({ a: 0 }),
      NOW + 10 * 60_000,
    )
    const times = onGrid.trace.map((p) => p.at)
    expect(new Set(times).size).toBe(times.length)
  })

  it('starts at what is left, falls at the pace of use, and steps up when a week resets', () => {
    // Two subscriptions with half their week left each; one resets in a day.
    const g = poolGaps(
      [sub('a', [0.5, 24 * H], [0, null]), sub('b', [0.5, 100 * H], [0, null])],
      NOW,
      rates({ a: 0.01, b: 0.01 }),
    )
    const at = (h: number) => g.trace.find((p) => p.at === NOW + h * H)
    // Each 5-hour window is unused but can take only what its week leaves: half each.
    expect(g.trace[0]).toEqual({
      at: NOW,
      weekly: 1,
      fiveHour: 1,
      weeklyBy: [0.5, 0.5],
      fiveHourBy: [0.5, 0.5],
      weeklyResetsBy: [NOW + 24 * H, NOW + 100 * H],
    })
    expect(g.subscriptions).toEqual(['a', 'b'])
    // Once a's week has reset, its next reset is a week on.
    expect(at(24)?.weeklyResetsBy).toEqual([NOW + 24 * H + WEEK_MS, NOW + 100 * H])
    // 2% of one subscription's week an hour: 0.98 left after an hour.
    expect(at(1)?.weekly).toBeCloseTo(0.98, 6)
    // a's week resets at 24h: what is left jumps by a's used share.
    const before = at(23 + 5 / 6)?.weekly ?? 0
    const after = at(24)?.weekly ?? 0
    expect(after - before).toBeGreaterThan(0.5)
    // Every sample is on the grid, to the horizon.
    expect(g.trace.every((p, i) => p.at === NOW + i * TRACE_STEP_MS)).toBe(true)
    expect(g.trace.at(-1)?.at).toBe(NOW + GAPS_HORIZON_MS)
  })

  it('shows a reset during a gap, and with no use at all', () => {
    // The week resets in an hour, the full 5-hour window in four: work stops until 4h, but the
    // week's allowance is back at 1h.
    const g = poolGaps([sub('a', [1, H], [1, 4 * H])], NOW)
    const at = (gaps: PoolGaps, h: number) => gaps.trace.find((p) => p.at === NOW + h * H)
    expect(at(g, 0.5)?.weekly).toBe(0)
    expect(at(g, 1)?.weekly).toBe(1)
    // Nothing used: half the week left until its reset at 24h, then all of it.
    const idle = poolGaps([sub('a', [0.5, 24 * H], [0, null])], NOW, rates({ a: 0 }))
    expect(at(idle, 23)?.weekly).toBe(0.5)
    expect(at(idle, 24)?.weekly).toBe(1)
  })

  it('counts no 5-hour capacity in a week that is used up', () => {
    // a's week is full for 50 hours: its 5-hour window resets and is empty, but cannot be used.
    const a = sub('a', [1, 50 * H], [0.1, 3 * H])
    const b = sub('b', [0.5, 60 * H], [0.2, 3 * H])
    const both = poolGaps([a, b], NOW, rates({ a: 0, b: 0 }))
    const bAlone = poolGaps([b], NOW, rates({ b: 0 }))
    const five = (g: PoolGaps, h: number) => g.trace.find((p) => p.at === NOW + h * H)?.fiveHour
    // Until a's week resets, the pool's 5-hour capacity is b's alone (b does the same work: the
    // pool's 5-hour pace includes a's average, so compare at the start and before b fills): its
    // window's 80% left, as far as the half of its week that is left.
    expect(five(both, 0)).toBeCloseTo(0.5, 6)
    expect(five(bAlone, 0)).toBeCloseTo(0.5, 6)
    for (const h of [5, 20, 49]) expect(five(both, h)).toBeLessThanOrEqual(1)
    // Once a's week resets, its window counts again.
    expect(five(both, 50)).toBeGreaterThan(1)
  })

  it('holds what is left through a gap, then shows the reset that ends it', () => {
    // Every week full until the first resets in 50h.
    const g = poolGaps(
      [sub('a', [1, 50 * H], [0.1, 3 * H]), sub('b', [1, 60 * H], [0.1, 3 * H])],
      NOW,
    )
    const at = (h: number) => g.trace.find((p) => p.at === NOW + h * H)
    expect(at(10)?.weekly).toBe(0)
    expect(at(49 + 5 / 6)?.weekly).toBe(0)
    expect(at(50)?.weekly).toBeCloseTo(1, 6)
  })
})

describe('gapsHeadline', () => {
  const g = (over: Partial<PoolGaps>): PoolGaps => ({
    counted: 2,
    unreported: 0,
    gaps: [],
    lasts: null,
    trace: [],
    clock: NOW,
    capacity: 2,
    subscriptions: [],
    pace: { weekly: 0, fiveHour: 0 },
    unusedAtReset: [],
    ...over,
  })
  const clock = (at: number) => `T+${(at - NOW) / H}h`

  it('says when nothing runs out, or nothing is known', () => {
    expect(gapsHeadline(null, NOW)).toEqual({
      tone: 'info',
      headline: 'Waiting for the first reading',
      facts: [],
    })
    expect(gapsHeadline(g({ lasts: 'unknown' }), NOW)).toEqual({
      tone: 'info',
      headline: 'No weekly usage reported yet',
      facts: [],
    })
    expect(gapsHeadline(g({ lasts: 'horizon' }), NOW)).toEqual({
      tone: 'success',
      headline: "Won't run out in the next 7 days",
      facts: [],
    })
  })

  it('says every login has expired, among the reporting ones when some do not report', () => {
    expect(gapsHeadline(g({ lasts: 'logins' }), NOW)).toEqual({
      tone: 'error',
      headline: 'Every login has expired',
      facts: ['Log in again on the server'],
    })
    expect(gapsHeadline(g({ lasts: 'logins', counted: 1, unreported: 1 }), NOW)).toEqual({
      tone: 'warning',
      headline: 'Every login has expired',
      facts: ['Based on 1 of 2 subscriptions'],
    })
  })

  it('names those it covers when some subscriptions do not report, and never reads as an error', () => {
    const out = g({
      counted: 3,
      unreported: 1,
      gaps: [{ start: NOW, end: NOW + 2 * H, endsWith: 'weekly' }],
    })
    expect(gapsHeadline(out, NOW)).toEqual({
      tone: 'warning',
      headline: 'Out now · back in 2h',
      facts: ['Based on 3 of 4 subscriptions'],
    })
  })

  it('says when no reset time is known', () => {
    expect(gapsHeadline(g({ gaps: [{ start: NOW + H, end: null, endsWith: null }] }), NOW)).toEqual(
      {
        tone: 'warning',
        headline: 'Runs out in 1h · no reset time known',
        facts: [],
      },
    )
  })

  it("gives the clock times when it has the viewer's zone", () => {
    const first = { start: NOW + H, end: NOW + 30 * H, endsWith: 'weekly' as const }
    const later = { start: NOW + 50 * H, end: NOW + 100 * H, endsWith: 'weekly' as const }
    expect(gapsHeadline(g({ gaps: [first, later] }), NOW, clock)).toEqual({
      tone: 'warning',
      headline: 'Runs out in 1h for 1d 5h',
      facts: ['T+1h until T+30h'],
    })
    expect(gapsHeadline(g({ gaps: [{ ...first, start: NOW }] }), NOW, clock)).toEqual({
      tone: 'error',
      headline: 'Out now · back in 1d 6h',
      facts: ['Back T+30h'],
    })
  })
})

describe('gapsHeadline: more than one gap in a day', () => {
  const g = (gaps: PoolGaps['gaps']): PoolGaps => ({
    counted: 2,
    unreported: 0,
    gaps,
    lasts: null,
    trace: [],
    clock: NOW,
    capacity: 2,
    subscriptions: [],
    pace: { weekly: 0, fiveHour: 0 },
    unusedAtReset: [],
  })
  const first = { start: NOW + 3 * H, end: NOW + 5 * H, endsWith: 'fiveHour' as const }

  it('adds how long the pool is out of the next 24 hours, counting only those hours', () => {
    // 2h, then 7h to 30h: 17h of it in the next day.
    const next = { start: NOW + 7 * H, end: NOW + 30 * H, endsWith: 'weekly' as const }
    expect(gapsHeadline(g([first, next]), NOW).headline).toBe(
      'Runs out in 3h for 2h and 19h of the next 24 hours',
    )
    expect(gapsHeadline(g([{ ...first, start: NOW }, next]), NOW).headline).toBe(
      'Out now · back in 5h and 22h of the next 24 hours',
    )
  })

  it('counts a gap with no known end to the end of the day', () => {
    const open = { start: NOW + 13 * H, end: null, endsWith: null }
    expect(gapsHeadline(g([first, open]), NOW).headline).toBe(
      'Runs out in 3h for 2h and 13h of the next 24 hours',
    )
  })

  it('leaves it out with one gap in the next 24 hours', () => {
    const later = { start: NOW + 25 * H, end: NOW + 30 * H, endsWith: 'weekly' as const }
    expect(gapsHeadline(g([first, later]), NOW).headline).toBe('Runs out in 3h for 2h')
  })
})

describe('poolGaps invariants (seeded)', () => {
  // A small deterministic generator, so a failure names its seed.
  function rng(seed: number) {
    let x = seed >>> 0 || 1
    return () => {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      return (x >>> 0) / 2 ** 32
    }
  }

  // 300 pools, each simulated over a week: slow on a shared CI runner, so a generous timeout.
  it('gives ordered gaps that do not overlap, end after they start, and have not ended by now', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T
      const profiles = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, i) =>
        sub(
          `s${i}`,
          r() < 0.1 ? null : [pick([0, r(), 0.9 + r() * 0.1, 1]), r() * WEEK_MS],
          r() < 0.3 ? null : [pick([0, r(), 1]), r() * FIVE_HOURS_MS],
          r() < 0.1 ? { tokenExpiresAt: NOW - 1 } : {},
        ),
      )
      const smoothed = new Map(profiles.map((p) => [p.profile, r() < 0.5 ? r() * 0.2 : null]))
      const g = poolGaps(profiles, NOW, smoothed, NOW)
      let previousEnd = Number.NEGATIVE_INFINITY
      for (const gap of g.gaps) {
        const where = `seed ${seed}: ${JSON.stringify(hours(g))}`
        expect(gap.start, where).toBeGreaterThanOrEqual(previousEnd)
        expect(gap.start, where).toBeLessThanOrEqual(NOW + GAPS_HORIZON_MS)
        if (gap.end !== null) {
          expect(gap.end, where).toBeGreaterThan(gap.start)
          expect(gap.end, where).toBeGreaterThan(NOW)
          expect(gap.endsWith, where).not.toBeNull()
        }
        previousEnd = gap.end ?? Number.POSITIVE_INFINITY
      }
      expect(g.lasts === null, `seed ${seed}`).toBe(g.gaps.length > 0)
      // The charts agree with the headline: the 5-hour capacity that can be used (windows whose
      // week has room) is nil in a gap and only there, since a subscription that can take work
      // has room in both. (No rate limits here, which stop work without using capacity.)
      const inGap = (t: number) =>
        g.gaps.some((gap) => t >= gap.start && (gap.end === null || t < gap.end))
      for (const point of g.trace) {
        if (point.at < NOW) continue
        const where = `seed ${seed} at ${(point.at - NOW) / H}h: ${JSON.stringify(hours(g))}`
        expect(point.fiveHour <= 1e-9, where).toBe(inGap(point.at))
      }
      // The status line and each fact start with a capital and are not sentences.
      const h = gapsHeadline(g, NOW)
      for (const line of [h.headline, ...h.facts]) {
        expect(line, `seed ${seed}`).toMatch(/^[A-Z][^.]*[^.]$/)
      }
    }
  }, 60_000)
})
