// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS, noFiveHourLimit, type ProfileStatus, WEEK_MS } from '../src/core/index'
import { PoolAccounts } from '../src/react/Pool'

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
  it("shows the week's room, dimmed; one with a 5-hour window is not dimmed", () => {
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
    const bar = (name: string) =>
      [...container.querySelectorAll('.cmd-account')]
        .find((e) => e.querySelector('.cmd-account-name')?.textContent === name)
        ?.querySelector('[data-window="fiveHour"]') as HTMLElement
    expect(bar('ultra').hasAttribute('data-dim')).toBe(true)
    expect((bar('ultra').firstElementChild as HTMLElement).style.height).toBe('75%')
    expect(bar('max').hasAttribute('data-dim')).toBe(false)
    expect((bar('max').firstElementChild as HTMLElement).style.height).toBe('50%')
  })
})
