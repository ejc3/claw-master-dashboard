import { describe, expect, it } from 'vitest'
import {
  boughtAt,
  COVERAGE_TARGET,
  capacityAdvice,
  coverage,
  GAPS_HORIZON_MS,
  HOUR_MS,
  type PoolGaps,
  type ProfileStatus,
  PURCHASE_STEP_MS,
  poolGaps,
} from '../src/core/index'
import { adviceLine } from '../src/react/Pool'

const NOW = Date.UTC(2026, 9, 11, 12)
const H = HOUR_MS
const WEEK = 168 * H

/** A subscription with `used` of its week gone, resetting in `resetIn`, no 5-hour reading. */
function sub(name: string, used: number, resetIn: number): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly: { usedFraction: used, resetsAt: NOW + resetIn, lengthMs: WEEK },
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
  }
}
// Each subscription's recent pace, as a share of its week an hour.
const rates = (pace: number, ...names: string[]) => new Map(names.map((n) => [n, pace]))

describe('coverage', () => {
  const g = (gaps: PoolGaps['gaps']) => ({ gaps }) as PoolGaps
  it('is the share of the week with a subscription that can take work', () => {
    expect(coverage(g([]), NOW)).toBe(1)
    expect(
      coverage(g([{ start: NOW + 24 * H, end: NOW + 48 * H, endsWith: 'weekly' }]), NOW),
    ).toBeCloseTo(6 / 7, 9)
    // An open gap runs to the horizon; a gap before now does not count.
    expect(coverage(g([{ start: NOW + 6 * 24 * H, end: null, endsWith: null }]), NOW)).toBeCloseTo(
      6 / 7,
      9,
    )
    expect(coverage(g([{ start: NOW - 5 * H, end: NOW, endsWith: 'weekly' }]), NOW)).toBe(1)
    // A forecast that cannot run covers nothing.
    expect(coverage({ gaps: [], lasts: 'logins' } as unknown as PoolGaps, NOW)).toBe(0)
    expect(coverage({ gaps: [], lasts: 'unknown' } as unknown as PoolGaps, NOW)).toBe(0)
    // Only to the forecast's end: a day after its reading six days remain, and a gap over its last
    // day is a sixth of them.
    const lastDay = g([{ start: NOW + 6 * 24 * H, end: null, endsWith: null }])
    expect(coverage(lastDay, NOW + 24 * H, NOW)).toBeCloseTo(5 / 6, 9)
    expect(GAPS_HORIZON_MS).toBe(WEEK)
  })
})

describe('capacityAdvice', () => {
  it('adds the fewest subscriptions that cover the target, bought as late as still works', () => {
    // Two subscriptions nearly used up for days, at a pace that empties a week every three days.
    const profiles = [sub('a', 0.9, 100 * H), sub('b', 0.9, 120 * H)]
    const smoothed = rates(1 / 144, 'a', 'b')
    const base = poolGaps(profiles, NOW, smoothed, NOW)
    expect(coverage(base, NOW)).toBeLessThan(COVERAGE_TARGET)
    const advice = capacityAdvice(profiles, NOW, smoothed, NOW)
    if (advice.kind !== 'add') throw new Error(`advice ${advice.kind}`)
    expect(advice.after).toBeGreaterThanOrEqual(COVERAGE_TARGET)
    // One fewer would not do.
    const with_ = (k: number, at: number) => [
      ...profiles,
      ...Array.from({ length: k }, (_, i) => boughtAt(`x${i}`, at)),
    ]
    const covered = (k: number, at: number) =>
      coverage(poolGaps(with_(k, at), NOW, smoothed, NOW, false, base.pace), NOW)
    if (advice.count > 1) expect(covered(advice.count - 1, NOW)).toBeLessThan(COVERAGE_TARGET)
    // Buying by then works, even inside the gap when that still cuts it short enough; no later step,
    // up to the gap's end, does.
    expect(covered(advice.count, advice.buyBy)).toBeGreaterThanOrEqual(COVERAGE_TARGET)
    const firstGap = base.gaps[0]?.start ?? NOW
    const lastGapEnd = Math.max(...base.gaps.map((x) => x.end ?? NOW + 168 * H))
    expect(advice.buyBy).toBeGreaterThan(firstGap)
    for (let at = lastGapEnd; at > advice.buyBy; at -= PURCHASE_STEP_MS) {
      expect(covered(advice.count, at)).toBeLessThan(COVERAGE_TARGET)
    }
  })

  it('drops what the pace does not need, cheapest loss first, keeping the target', () => {
    // Five fresh subscriptions at a pace that uses a tenth of one week a day.
    const names = ['a', 'b', 'c', 'd', 'e']
    const profiles = names.map((n, i) => sub(n, 0.1, (24 + 24 * i) * H))
    const smoothed = rates(0.1 / 24 / 5, ...names)
    const advice = capacityAdvice(profiles, NOW, smoothed, NOW)
    if (advice.kind !== 'remove') throw new Error(`advice ${advice.kind}`)
    expect(advice.remove.length).toBeGreaterThan(0)
    expect(advice.remove.length).toBeLessThan(names.length)
    expect(advice.after).toBeGreaterThanOrEqual(COVERAGE_TARGET)
    // Each is cancelled after its week resets, so the paid week is used.
    for (const r of advice.remove) {
      expect(r.after).toBe(profiles.find((p) => p.profile === r.profile)?.weekly.resetsAt)
    }
  })

  it("keeps the people's pace when a subscription goes: the work moves, it does not vanish", () => {
    // Both fresh, b doing all the recent work at a hundredth of a week an hour: together they last
    // 200 hours, past both resets at 150. Either alone at that pace runs out at 100 hours and waits
    // 50 for its reset, so neither can go, even the one that did none of the work.
    const profiles = [sub('a', 0, 150 * H), sub('b', 0, 150 * H)]
    const smoothed = new Map([
      ['a', 0],
      ['b', 1 / 100],
    ])
    expect(capacityAdvice(profiles, NOW, smoothed, NOW)).toEqual({ kind: 'enough', now: 1 })
  })

  it('never cancels the last subscription that can work', () => {
    const usable = sub('a', 0, 100 * H)
    const expired = { ...sub('b', 0, 100 * H), tokenExpiresAt: NOW - H }
    const advice = capacityAdvice([usable, expired], NOW, rates(0.001, 'a', 'b'), NOW)
    expect(advice.kind === 'remove' && advice.remove.some((r) => r.profile === 'a')).toBe(false)
  })

  it('says enough when one subscription covers the week, and unknown with no readings', () => {
    expect(capacityAdvice([sub('a', 0, 100 * H)], NOW, rates(0.001, 'a'), NOW)).toEqual({
      kind: 'enough',
      now: 1,
    })
    const noReading = {
      ...sub('a', 0, 100 * H),
      weekly: { usedFraction: null, resetsAt: null, lengthMs: WEEK },
    }
    expect(capacityAdvice([noReading], NOW, new Map(), NOW)).toEqual({ kind: 'unknown', now: null })
  })
})

describe('adviceLine', () => {
  const names = new Map([
    ['claude-a', 'a'],
    ['claude-b', 'b'],
  ])
  const clock = (t: number) => `T+${(t - NOW) / H}h`
  it('says how many to add and by when, or now', () => {
    const add = { kind: 'add' as const, count: 2, buyBy: NOW + 14 * H, now: 0.49, after: 1 }
    expect(adviceLine(add, names, NOW, clock)).toBe(
      'Add 2 subscriptions by T+14h for tokens 95% of the week (49% now)',
    )
    expect(adviceLine({ ...add, count: 1, buyBy: NOW }, names, NOW, null)).toBe(
      'Add 1 subscription now for tokens 95% of the week (49% now)',
    )
    expect(adviceLine(add, names, NOW, null)).toBe(
      'Add 2 subscriptions in 14h for tokens 95% of the week (49% now)',
    )
  })
  it('says which could be cancelled, after their weeks reset', () => {
    const remove = {
      kind: 'remove' as const,
      of: 5,
      remove: [
        { profile: 'claude-a', after: NOW + 3 * H },
        { profile: 'claude-b', after: NOW + 5 * H },
      ],
      now: 1,
      after: 0.97,
    }
    expect(adviceLine(remove, names, NOW, clock)).toBe(
      'At this pace about 3 of 5 subscriptions cover the work: could cancel a after T+3h and b after T+5h',
    )
    expect(adviceLine({ ...remove, remove: remove.remove.slice(0, 1) }, names, NOW, null)).toBe(
      'At this pace about 4 of 5 subscriptions cover the work: could cancel a in 3h',
    )
  })
  it('says nothing when the pool is right as it is or the forecast cannot tell', () => {
    expect(adviceLine({ kind: 'enough', now: 1 }, names, NOW, clock)).toBeNull()
    expect(adviceLine({ kind: 'unknown', now: null }, names, NOW, clock)).toBeNull()
    expect(adviceLine(null, names, NOW, clock)).toBeNull()
  })
})
