// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS, noFiveHourLimit, type ProfileStatus, WEEK_MS } from '../src/core/index'
import { backIn, PoolAccounts } from '../src/react/Pool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.UTC(2026, 10, 22, 18, 0, 0)
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

const sub = (
  profile: string,
  weekUsed: number | null,
  five: ProfileStatus['fiveHour'],
): ProfileStatus => ({
  profile,
  band: weekUsed === null ? 'unknown' : 'ok',
  weekly: { usedFraction: weekUsed, resetsAt: NOW + 50 * HOUR_MS, lengthMs: WEEK_MS },
  fiveHour: five,
  rateLimitedUntil: null,
  tokenExpiresAt: null,
  latencyMs: { p50: null, p95: null, p99: null },
})

// Anthropic drops the 5-hour limit for verified Ultra accounts: the poll reads the week and no 5-hour
// window. That is no limit, not a missing reading.
describe('a subscription with no 5-hour limit', () => {
  it('is one whose week is read with no 5-hour figure', () => {
    expect(noFiveHourLimit(sub('a', 0.3, null))).toBe(true)
    expect(noFiveHourLimit(sub('a', null, null))).toBe(false)
    expect(
      noFiveHourLimit(
        sub('a', 0.3, { usedFraction: 0.1, resetsAt: NOW + HOUR_MS, lengthMs: 5 * HOUR_MS }),
      ),
    ).toBe(false)
  })

  it('says no limit, where a subscription with no reading at all says so', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[sub('team-ultra', 0.3, null), sub('team-unread', null, null)]}
          now={NOW}
        />,
      ),
    )
    const row = (name: string) =>
      [...container.querySelectorAll('.cmd-account')].find(
        (e) => e.querySelector('.cmd-account-name')?.textContent === name,
      ) as Element
    expect(row('ultra').textContent).toContain('5-hour no limit')
    expect(row('unread').textContent).toContain('5-hour no reading')
    act(() => (row('ultra').querySelector('button') as HTMLButtonElement).click())
    expect(container.querySelector('.cmd-account-detail')?.textContent).toContain(
      'No 5-hour limit on this plan',
    )
  })
})

describe('the 5-hour bar of a subscription with no 5-hour limit', () => {
  it('has no ring, only a space that keeps the bars lined up; one with a 5-hour window has its ring', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[
            sub('team-ultra', 0.25, null),
            sub('team-max', 0.25, {
              usedFraction: 0.5,
              resetsAt: NOW + HOUR_MS,
              lengthMs: 5 * HOUR_MS,
            }),
          ]}
          now={NOW}
        />,
      ),
    )
    const cell = (name: string) =>
      [...container.querySelectorAll('.cmd-account')].find(
        (e) => e.querySelector('.cmd-account-name')?.textContent === name,
      ) as HTMLElement
    expect(cell('ultra').querySelector('[data-window="fiveHour"]')).toBeNull()
    expect(cell('ultra').querySelector('.cmd-account-marks > .cmd-ring-none')).not.toBeNull()
    expect(cell('max').querySelector('.cmd-ring-none')).toBeNull()
    expect(cell('max').querySelector('[data-window="fiveHour"]')?.getAttribute('data-left')).toBe(
      '50%',
    )
  })
})

describe('a subscription out until its 5-hour window resets', () => {
  it('is greyed out, not struck through; out for its week, its login or not out at all is not', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const window = (used: number) => ({
      usedFraction: used,
      resetsAt: NOW + 46 * 60_000,
      lengthMs: 5 * HOUR_MS,
    })
    const stale = { acceptedAt: NOW - HOUR_MS }
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[
            // The poll reads the window full and Anthropic has stopped taking its work.
            { ...sub('team-waiting', 0.27, window(1)), ...stale },
            // A 429 hold that ends before the week resets, with the window read under 100%.
            { ...sub('team-held', 0.27, window(0.8)), rateLimitedUntil: NOW + 30 * 60_000 },
            // The poll reads 100% but Anthropic still took its work lately: nearly out, still in.
            sub('team-nearly', 0.27, window(1)),
            { ...sub('team-spent', 1, window(0.4)), ...stale },
            { ...sub('team-login', 0.27, window(1)), ...stale, tokenExpiresAt: NOW - 1 },
            sub('team-open', 0.3, window(0.5)),
          ]}
          now={NOW}
        />,
      ),
    )
    const cell = (name: string) =>
      [...container.querySelectorAll('.cmd-account')].find((c) =>
        c.textContent?.includes(name),
      ) as HTMLElement
    const state = (name: string) => [
      cell(name).getAttribute('data-open'),
      cell(name).hasAttribute('data-five-out'),
    ]
    expect(state('waiting')).toEqual(['false', true])
    expect(state('held')).toEqual(['false', true])
    expect(state('nearly')).toEqual(['true', false])
    expect(state('spent')).toEqual(['false', false])
    expect(state('login')).toEqual(['false', false])
    expect(state('open')).toEqual(['true', false])
  })
})

describe("when a subscription out for now is back, in its ring's place", () => {
  it('reads in whole minutes under an hour, as the detail does, hours under two days, else days, never zero', () => {
    expect(backIn(10_000)).toBe('1m')
    expect(backIn(47 * 60_000)).toBe('47m')
    expect(backIn(59.5 * 60_000)).toBe('59m')
    expect(backIn(2 * HOUR_MS + 59 * 60_000)).toBe('3h')
    expect(backIn(47 * HOUR_MS)).toBe('47h')
    expect(backIn(50 * HOUR_MS)).toBe('2d')
  })
})

describe('the 5-hour mark of each kind of subscription', () => {
  it('is no ring for one out for the week, when it is back for one out for now, and the ring for one available', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const fiveHour = (used: number) => ({
      usedFraction: used,
      resetsAt: NOW + 2 * HOUR_MS,
      lengthMs: 5 * HOUR_MS,
    })
    act(() =>
      root.render(
        <PoolAccounts
          profiles={[
            // Refused until its week resets: out for the week.
            { ...sub('team-week', 1, fiveHour(0.2)), rateLimitedUntil: NOW + 50 * HOUR_MS },
            // Its 5-hour window full and no work taken for an hour: out for now.
            { ...sub('team-now', 0.3, fiveHour(1)), acceptedAt: NOW - HOUR_MS },
            sub('team-open', 0.3, fiveHour(0.4)),
          ]}
          now={NOW}
        />,
      ),
    )
    const cell = (name: string) =>
      [...container.querySelectorAll('.cmd-account')].find(
        (e) => e.querySelector('.cmd-account-name')?.textContent === name,
      ) as Element
    const mark = (name: string) =>
      ['.cmd-ring', '.cmd-ring-none', '.cmd-ring-back']
        .filter((m) => cell(name).querySelector(m) !== null)
        .map((m) =>
          m === '.cmd-ring-back'
            ? `${m} ${cell(name).querySelector('.cmd-ring-back-time')?.textContent} donut ${cell(name).querySelector('.cmd-ring-back-donut .cmd-ring-track') !== null}`
            : m,
        )
    expect(mark('week')).toEqual(['.cmd-ring-none'])
    expect(mark('now')).toEqual(['.cmd-ring-back 2h donut true'])
    expect(mark('open')).toEqual(['.cmd-ring'])
  })
})
