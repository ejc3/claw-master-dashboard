import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_RECENTLY_MS,
  BadQueryError,
  blocked,
  FIVE_HOURS_MS,
  fiveHourLeft,
  forecastProfiles,
  formatCount,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatWhen,
  HOUR_MS,
  hasHeadroom,
  MAX_POINTS,
  nextAvailable,
  nextRunOut,
  POLL_FULL_LEFT,
  type ProfileStatus,
  pollSaysUsedUp,
  poolGaps,
  type SeriesQuery,
  seriesQueryFromParams,
  seriesQueryToParams,
  WEEK_MS,
} from '../src/core/index'

const NOW = Date.UTC(2026, 9, 9, 12)

function profile(name: string, overrides: Partial<ProfileStatus> = {}): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly: { usedFraction: 0.2, resetsAt: NOW + 3 * 24 * HOUR_MS, lengthMs: WEEK_MS },
    fiveHour: { usedFraction: 0.1, resetsAt: NOW + 4 * HOUR_MS, lengthMs: FIVE_HOURS_MS },
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...overrides,
  }
}

describe('wire format', () => {
  const query: SeriesQuery = {
    metric: 'requests',
    groupBy: 'client',
    range: { start: NOW - 24 * HOUR_MS, end: NOW },
    stepSeconds: 300,
  }

  it('round-trips a series query', () => {
    expect(seriesQueryFromParams(seriesQueryToParams(query))).toEqual(query)
    const { groupBy: _, ...total } = query
    expect(seriesQueryFromParams(seriesQueryToParams(total))).toEqual(total)
  })

  it.each([
    ['an unknown metric', { metric: 'secrets' }],
    ['a split the metric does not have', { groupBy: 'model', metric: 'errors' }],
    ['a reversed range', { start: String(NOW), end: String(NOW - 1) }],
    ['a range over 15 days', { start: String(NOW - 16 * 24 * HOUR_MS) }],
    ['a step under a minute', { step: '30' }],
    ['too many points', { start: String(NOW - 14 * 24 * HOUR_MS), step: '60' }],
    ['a non-numeric bound', { start: '1e12' }],
  ])('refuses %s', (_, change) => {
    const params = seriesQueryToParams(query)
    for (const [k, v] of Object.entries(change)) params.set(k, v)
    expect(() => seriesQueryFromParams(params)).toThrow(BadQueryError)
  })

  it('accepts exactly the point limit', () => {
    const params = seriesQueryToParams({
      ...query,
      range: { start: NOW - MAX_POINTS * 60_000, end: NOW },
      stepSeconds: 60,
    })
    expect(() => seriesQueryFromParams(params)).not.toThrow()
  })
})

describe('headline', () => {
  it('counts only a subscription Anthropic is refusing as out, not one the poll calls used up', () => {
    expect(hasHeadroom(profile('a'), NOW)).toBe(true)
    // The poll reads whole percents: its 100% can still be under Anthropic's, which keeps taking work.
    const pollFull = profile('a', {
      band: 'exhausted',
      weekly: { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: WEEK_MS },
    })
    expect(hasHeadroom(pollFull, NOW)).toBe(true)
    expect(pollSaysUsedUp(pollFull, NOW)).toBe(true)
    // Anthropic refused it (a 429): out until the refusal ends.
    expect(hasHeadroom(profile('a', { rateLimitedUntil: NOW + 60_000 }), NOW)).toBe(false)
    expect(hasHeadroom(profile('a', { rateLimitedUntil: NOW - 60_000 }), NOW)).toBe(true)
    expect(pollSaysUsedUp({ ...pollFull, rateLimitedUntil: NOW + 60_000 }, NOW)).toBe(false)
  })

  it('finds the soonest projected run-out among subscriptions with headroom', () => {
    // 80% of a 5-hour window gone in 2.5 hours: the rest lasts about 37 minutes.
    const fast = profile('fast', {
      fiveHour: { usedFraction: 0.8, resetsAt: NOW + 2.5 * HOUR_MS, lengthMs: FIVE_HOURS_MS },
    })
    const refused = profile('refused', {
      band: 'exhausted',
      weekly: { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: WEEK_MS },
      rateLimitedUntil: NOW + HOUR_MS,
    })
    const runOut = nextRunOut([profile('slow'), refused, fast], NOW)
    expect(runOut?.profile).toBe('fast')
    expect(runOut?.window).toBe('fiveHour')
    expect(((runOut?.at ?? 0) - NOW) / 60_000).toBeCloseTo(37.5, 0)
    expect(nextRunOut([profile('slow')], NOW)).toBeNull()
  })

  it('counts no reading and an expired login as out; a used-up 5-hour reading is nearly out', () => {
    expect(hasHeadroom(profile('a', { band: 'unknown' }), NOW)).toBe(false)
    expect(hasHeadroom(profile('a', { tokenExpiresAt: NOW - 1 }), NOW)).toBe(false)
    expect(hasHeadroom(profile('a', { tokenExpiresAt: NOW + HOUR_MS }), NOW)).toBe(true)
    const fiveHourSpent = { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: FIVE_HOURS_MS }
    expect(hasHeadroom(profile('a', { fiveHour: fiveHourSpent }), NOW)).toBe(true)
    expect(pollSaysUsedUp(profile('a', { fiveHour: fiveHourSpent }), NOW)).toBe(true)
    // Once that window has reset, the old reading says nothing.
    const reset = { ...fiveHourSpent, resetsAt: NOW - 1 }
    expect(pollSaysUsedUp(profile('a', { fiveHour: reset }), NOW)).toBe(false)
  })

  it("counts the poll's 100% as out until its reset unless Anthropic took the subscription's work lately", () => {
    const weekSpent = { usedFraction: 1, resetsAt: NOW + 26 * HOUR_MS, lengthMs: WEEK_MS }
    const fiveSpent = { usedFraction: 1, resetsAt: NOW + 2 * HOUR_MS, lengthMs: FIVE_HOURS_MS }
    // Nothing accepted in the look-back: out until the week (or, with only the 5-hour window used
    // up, that window) resets.
    const idle = profile('a', { weekly: weekSpent, acceptedAt: null })
    expect(hasHeadroom(idle, NOW)).toBe(false)
    expect(blocked(idle, NOW)).toEqual({ reason: 'used-up', until: NOW + 26 * HOUR_MS })
    expect(pollSaysUsedUp(idle, NOW)).toBe(false)
    expect(blocked(profile('a', { fiveHour: fiveSpent, acceptedAt: null }), NOW)).toEqual({
      reason: 'used-up',
      until: NOW + 2 * HOUR_MS,
    })
    // Taken longer ago than ACCEPTED_RECENTLY_MS: still out.
    const stale = profile('a', {
      weekly: weekSpent,
      acceptedAt: NOW - ACCEPTED_RECENTLY_MS - 60_000,
    })
    expect(blocked(stale, NOW)?.reason).toBe('used-up')
    // Anthropic took its work this minute: its last percent is still being spent, so nearly out.
    const busy = profile('a', { weekly: weekSpent, acceptedAt: NOW - 60_000 })
    expect(blocked(busy, NOW)).toBeNull()
    expect(pollSaysUsedUp(busy, NOW)).toBe(true)
    // A refusal still says so, and below 100% nothing changes.
    const refused = profile('a', {
      weekly: weekSpent,
      acceptedAt: null,
      rateLimitedUntil: NOW + HOUR_MS,
    })
    expect(blocked(refused, NOW)?.reason).toBe('rate-limited')
    expect(blocked(profile('a', { acceptedAt: null }), NOW)).toBeNull()
    // The forecast keeps the last percent only for the subscription Anthropic is still taking work from.
    expect(forecastProfiles([idle], NOW)[0]?.weekly.usedFraction).toBe(1)
    expect(forecastProfiles([busy], NOW)[0]?.weekly.usedFraction).toBe(1 - POLL_FULL_LEFT)
  })

  it('says when the first refused subscription takes work again', () => {
    const later = profile('later', { rateLimitedUntil: NOW + 9 * HOUR_MS })
    const limited = profile('limited', { rateLimitedUntil: NOW + 2 * HOUR_MS })
    const expired = profile('expired', { tokenExpiresAt: NOW - 1 })
    expect(nextAvailable([later, limited, expired], NOW)).toEqual({
      profile: 'limited',
      at: NOW + 2 * HOUR_MS,
    })
    expect(nextAvailable([later], NOW)?.at).toBe(NOW + 9 * HOUR_MS)
    expect(nextAvailable([expired], NOW)).toBeNull()
  })

  it('gives the forecast the last percent of a window the poll calls used up', () => {
    const pollFull = profile('a', {
      weekly: { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: WEEK_MS },
      fiveHour: { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: FIVE_HOURS_MS },
    })
    const [seen] = forecastProfiles([pollFull], NOW)
    expect(seen?.weekly.usedFraction).toBe(1 - POLL_FULL_LEFT)
    expect(seen?.fiveHour?.usedFraction).toBe(1 - POLL_FULL_LEFT)
    // A refused one too: its refusal holds it until it ends, then claw-master asks again.
    const refused = { ...pollFull, rateLimitedUntil: NOW + 10 * 60_000 }
    expect(forecastProfiles([refused], NOW)[0]?.weekly.usedFraction).toBe(1 - POLL_FULL_LEFT)
    // So a 10-minute refusal on a poll-full week resetting in 9 hours is back in 10 minutes.
    const nineHours = {
      ...refused,
      weekly: { usedFraction: 1, resetsAt: NOW + 9 * HOUR_MS, lengthMs: WEEK_MS },
      fiveHour: null,
    }
    const back = poolGaps(forecastProfiles([nineHours], NOW), NOW, new Map([['a', 0]]), NOW).gaps[0]
    expect(back?.end).toBe(NOW + 10 * 60_000)
    // Refused through the reset: nothing of that week is left, so nothing is counted unused at it.
    const throughReset = { ...nineHours, rateLimitedUntil: NOW + 9 * HOUR_MS }
    expect(forecastProfiles([throughReset], NOW)[0]?.weekly.usedFraction).toBe(1)
    const g = poolGaps(forecastProfiles([throughReset], NOW), NOW, new Map([['a', 0]]), NOW)
    expect(g.unusedAtReset).toEqual([])
    const half = profile('b')
    expect(forecastProfiles([half], NOW)[0]?.weekly).toBe(half.weekly)
  })
})

describe('format', () => {
  it('counts down in the two largest units', () => {
    // Past two days, days only: the hours say little there.
    expect(formatCountdown(3 * 24 * HOUR_MS + 2 * HOUR_MS + 5 * 60_000)).toBe('3d')
    expect(formatCountdown(2 * 24 * HOUR_MS + 23 * HOUR_MS)).toBe('2d')
    expect(formatCountdown(24 * HOUR_MS + 23 * HOUR_MS)).toBe('1d 23h')
    expect(formatCountdown(2 * 24 * HOUR_MS)).toBe('2d')
    expect(formatCountdown(2 * HOUR_MS + 12 * 60_000)).toBe('2h 12m')
    expect(formatCountdown(12 * 60_000 + 59_000)).toBe('12m')
    expect(formatCountdown(40_000)).toBe('40s')
    expect(formatCountdown(0)).toBe('now')
  })

  it('formats shares, counts and durations, with a dash for unknown', () => {
    expect(formatPercent(0.424)).toBe('42%')
    expect(formatPercent(0.025)).toBe('2.5%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.996)).toBe('99.6%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(null)).toBe('—')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(12_400)).toBe('12.4K')
    expect(formatDuration(840)).toBe('840 ms')
    expect(formatDuration(14_230)).toBe('14.2 s')
    expect(formatDuration(null)).toBe('—')
  })

  it('names a time by how far away it is', () => {
    expect(formatWhen(NOW + 2 * HOUR_MS, NOW, 'UTC')).toBe('2:00 PM')
    expect(formatWhen(Date.UTC(2026, 9, 12, 9, 30), NOW, 'UTC')).toBe('Mon 9:30 AM')
    expect(formatWhen(Date.UTC(2026, 9, 30, 9, 30), NOW, 'UTC')).toBe('Oct 30, 9:30 AM')
  })
})

describe('fiveHourLeft', () => {
  const five = (usedFraction: number | null, resetsAt = NOW + HOUR_MS) => ({
    usedFraction,
    resetsAt,
    lengthMs: FIVE_HOURS_MS,
  })
  const week = (usedFraction: number | null) => ({
    usedFraction,
    resetsAt: NOW + 3 * 24 * HOUR_MS,
    lengthMs: WEEK_MS,
  })

  it('is what the 5-hour window leaves while the week leaves more', () => {
    expect(fiveHourLeft(profile('a', { weekly: week(0.2), fiveHour: five(0.7) }), NOW)).toBeCloseTo(
      0.3,
    )
  })

  it('is never more than the week leaves', () => {
    expect(fiveHourLeft(profile('a', { weekly: week(0.9), fiveHour: five(0.2) }), NOW)).toBeCloseTo(
      0.1,
    )
    // A window that has reset is unused, but the week still caps it.
    expect(
      fiveHourLeft(profile('a', { weekly: week(0.6), fiveHour: five(1, NOW - 1) }), NOW),
    ).toBeCloseTo(0.4)
  })

  it('is nothing while Anthropic refuses the subscription', () => {
    const refused = profile('a', {
      weekly: week(0.3),
      fiveHour: five(0.2),
      rateLimitedUntil: NOW + HOUR_MS,
    })
    expect(fiveHourLeft(refused, NOW)).toBe(0)
    // Once the refusal ends, the window counts again.
    expect(fiveHourLeft(refused, NOW + HOUR_MS)).toBeCloseTo(0.7)
  })

  it('is unknown with no 5-hour reading, unless the week is used up', () => {
    expect(fiveHourLeft(profile('a', { weekly: week(0.5), fiveHour: null }), NOW)).toBeNull()
    expect(fiveHourLeft(profile('a', { weekly: week(1), fiveHour: null }), NOW)).toBe(0)
    expect(
      fiveHourLeft(profile('a', { weekly: week(null), fiveHour: five(0.25) }), NOW),
    ).toBeCloseTo(0.75)
  })
})
