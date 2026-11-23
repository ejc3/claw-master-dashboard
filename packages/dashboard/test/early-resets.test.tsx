// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type EpochMs,
  earlyResets,
  earlyResetTimes,
  HOUR_MS,
  type ProfileStatus,
  WEEK_MS,
} from '../src/core/index'
import { PoolAccounts } from '../src/react/Pool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.UTC(2026, 10, 23, 3, 0, 0)
const STEP = 10 * 60_000

/** Ten-minute buckets from `start`, one value each. */
const buckets = (start: EpochMs, values: number[]): Array<[EpochMs, number]> =>
  values.map((v, i) => [start + i * STEP, v])

describe('earlyResetTimes', () => {
  const start = NOW - 2 * HOUR_MS
  // A week due 73 hours on: the countdown read in every bucket.
  const countdown = (dueAt: EpochMs, n = 8) =>
    buckets(
      start,
      Array.from({ length: n }, (_, i) => (dueAt - (start + i * STEP)) / 1000),
    )

  it('finds a fall to nothing while the week was not due for days, at the first new reading', () => {
    const used = buckets(start, [0.98, 0.99, 1, 1, 0, 0.01, 0.02, 0.02])
    const resets = earlyResetTimes(used, countdown(start + 73 * HOUR_MS), STEP, 0, NOW + HOUR_MS)
    expect(resets).toEqual([start + 4 * STEP])
  })

  it('leaves out an ordinary reset, even though the bucket holding it reads the next week', () => {
    const due = start + 3 * STEP + 5 * 60_000
    // The countdown: to the old reset, then (from the bucket holding it) to a week later.
    const left = buckets(
      start,
      Array.from({ length: 8 }, (_, i) => {
        const t = start + i * STEP
        return (i >= 3 ? due + WEEK_MS - t : due - t) / 1000
      }),
    )
    const used = buckets(start, [0.6, 0.62, 0.64, 0.65, 0, 0.01, 0.02, 0.02])
    expect(earlyResetTimes(used, left, STEP, 0, NOW + HOUR_MS)).toEqual([])
  })

  it('leaves out a small correction, a fall across a gap, and one with no countdown read before it', () => {
    const due = countdown(start + 73 * HOUR_MS)
    expect(earlyResetTimes(buckets(start, [0.5, 0.45, 0.46]), due, STEP, 0, NOW + HOUR_MS)).toEqual(
      [],
    )
    const gap: Array<[EpochMs, number]> = [
      [start, 0.9],
      [start + 3 * STEP, 0],
    ]
    expect(earlyResetTimes(gap, due, STEP, 0, NOW + HOUR_MS)).toEqual([])
    expect(earlyResetTimes(buckets(start, [0.9, 0]), [], STEP, 0, NOW + HOUR_MS)).toEqual([])
  })

  it('counts only those in [from, to)', () => {
    const used = buckets(start, [0.98, 0, 0.01, 0.9, 0])
    const resets = earlyResetTimes(
      used,
      countdown(start + 73 * HOUR_MS),
      STEP,
      start + 2 * STEP,
      NOW,
    )
    expect(resets).toEqual([start + 4 * STEP])
  })
})

describe('earlyResets', () => {
  it("keeps a week's and a Fable allowance's apart, and a Fable fall with the week's is the week's", () => {
    const start = NOW - 2 * HOUR_MS
    const due = start + 73 * HOUR_MS
    const left = buckets(
      start,
      Array.from({ length: 8 }, (_, i) => (due - (start + i * STEP)) / 1000),
    )
    const out = earlyResets(
      {
        stepMs: STEP,
        weeklyUsed: [
          { key: 'a', points: buckets(start, [1, 1, 0, 0, 0, 0, 0, 0]) },
          { key: 'b', points: buckets(start, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]) },
          { key: 'c', points: buckets(start, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]) },
        ],
        weeklyResetsInSeconds: ['a', 'b', 'c'].map((key) => ({ key, points: left })),
        fableUsed: [
          { key: 'a', points: buckets(start, [0.5, 0.5, 0, 0, 0, 0, 0, 0]) },
          { key: 'b', points: buckets(start, [0.7, 0.7, 0, 0, 0.6, 0, 0, 0]) },
        ],
        fableResetsInSeconds: ['a', 'b'].map((key) => ({ key, points: left })),
      },
      0,
      NOW + HOUR_MS,
    )
    expect(out.get('a')).toEqual({ weekly: [start + 2 * STEP], fable: [] })
    expect(out.get('b')).toEqual({ weekly: [], fable: [start + 2 * STEP, start + 5 * STEP] })
    expect(out.has('c')).toBe(false)
  })
})

let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const sub = (profile: string): ProfileStatus => ({
  profile,
  band: 'ok',
  weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: WEEK_MS },
  fiveHour: null,
  rateLimitedUntil: null,
  tokenExpiresAt: null,
  latencyMs: { p50: null, p95: null, p99: null },
})

describe('the early-reset badges', () => {
  it('count a red week and a blue Fable beside the name, say them, and list them in the detail', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[sub('team-gift'), sub('team-plain')]}
          now={NOW}
          earlyResets={
            new Map([
              [
                'team-gift',
                { weekly: [NOW - 2 * HOUR_MS, NOW - 30 * HOUR_MS], fable: [NOW - 5 * HOUR_MS] },
              ],
            ])
          }
        />,
      ),
    )
    const cells = [...container.querySelectorAll('.cmd-account')]
    const gift = cells.find((c) => c.textContent?.includes('gift')) as HTMLElement
    const plain = cells.find((c) => c.textContent?.includes('plain')) as HTMLElement
    const badges = [...gift.querySelectorAll('.cmd-reset-badge')].map((b) => [
      b.getAttribute('data-window'),
      b.textContent,
    ])
    expect(badges).toEqual([
      ['weekly', '2'],
      ['fable', '1'],
    ])
    // Beside the name, inside the label, so the bar and ring stay where every row has them.
    expect(gift.querySelector('.cmd-account-label .cmd-reset-badges')).not.toBeNull()
    expect(plain.querySelector('.cmd-reset-badges')).toBeNull()
    expect(gift.querySelector('.cmd-visually-hidden')?.textContent).toContain(
      'week reset early twice, Fable reset early once this past week',
    )
    expect(container.querySelector('.cmd-accounts-legend')?.textContent).toContain(
      'badge: reset early this past week (red: week, blue: Fable)',
    )
    act(() => (gift.querySelector('button') as HTMLButtonElement).click())
    const lines = [...container.querySelectorAll('.cmd-reset-line')].map((l) => [
      l.getAttribute('data-window'),
      l.textContent,
    ])
    expect(lines.map(([w]) => w)).toEqual(['weekly', 'fable'])
    expect(lines[0]?.[1]).toMatch(/^Week reset early by Anthropic twice this past week: .+, .+$/)
    expect(lines[1]?.[1]).toMatch(/^Fable reset early by Anthropic once this past week: .+$/)
  })
})
