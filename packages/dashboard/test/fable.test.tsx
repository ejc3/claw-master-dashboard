// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fableLeft, fableSummary, HOUR_MS, type ProfileStatus, WEEK_MS } from '../src/core/index'
import { PoolAccounts, PoolOutlook } from '../src/react/Pool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const NOW = Date.UTC(2026, 9, 9, 18, 2, 0)
let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('ResizeObserver', SilentResizeObserver)
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const sub = (profile: string, fable: ProfileStatus['fable'], weekUsed = 0.4): ProfileStatus => ({
  profile,
  band: 'ok',
  weekly: { usedFraction: weekUsed, resetsAt: NOW + 50 * HOUR_MS, lengthMs: WEEK_MS },
  fiveHour: null,
  rateLimitedUntil: null,
  tokenExpiresAt: null,
  latencyMs: { p50: null, p95: null, p99: null },
  ...(fable === undefined ? {} : { fable }),
})

describe('fableLeft', () => {
  it('is what the allowance leaves, nothing while refused or with the week used up, all of it after the reset', () => {
    expect(
      fableLeft(sub('a', { usedFraction: 0.3, resetsAt: NOW + HOUR_MS, refusedUntil: null }), NOW),
    ).toBeCloseTo(0.7)
    expect(
      fableLeft(
        sub('a', { usedFraction: 0.3, resetsAt: NOW + HOUR_MS, refusedUntil: NOW + 60_000 }),
        NOW,
      ),
    ).toBe(0)
    expect(
      fableLeft(
        sub('a', { usedFraction: 0.3, resetsAt: NOW + HOUR_MS, refusedUntil: null }, 1),
        NOW,
      ),
    ).toBe(0)
    expect(
      fableLeft(sub('a', { usedFraction: 1, resetsAt: NOW - 1, refusedUntil: null }), NOW),
    ).toBe(1)
    // A refusal that has ended no longer counts.
    expect(
      fableLeft(
        sub('a', { usedFraction: 0.5, resetsAt: NOW + HOUR_MS, refusedUntil: NOW - 1 }),
        NOW,
      ),
    ).toBe(0.5)
    expect(fableLeft(sub('a', null), NOW)).toBeNull()
    expect(fableLeft(sub('a', undefined), NOW)).toBeNull()
  })

  it('never leaves more than the week does, in Fable units (half the week)', () => {
    // 10% of the week left is 20% of a Fable allowance that is half the week.
    expect(
      fableLeft(
        sub('a', { usedFraction: 0.25, resetsAt: NOW + HOUR_MS, refusedUntil: null }, 0.9),
        NOW,
      ),
    ).toBeCloseTo(0.2)
    expect(
      fableLeft(
        sub('a', { usedFraction: 0.25, resetsAt: NOW + HOUR_MS, refusedUntil: null }, 0.2),
        NOW,
      ),
    ).toBeCloseTo(0.75)
  })

  it('leaves all of it when both weeks have reset before the next poll', () => {
    const reset = sub('a', { usedFraction: 1, resetsAt: NOW - 1, refusedUntil: null }, 1)
    reset.weekly = { ...reset.weekly, resetsAt: NOW - 1 }
    expect(fableLeft(reset, NOW)).toBe(1)
    expect(fableSummary([reset], NOW)?.canTake).toBe(1)
  })

  it('counts a subscription as able to take Fable only when it is available', () => {
    const limited = sub('a', { usedFraction: 0.1, resetsAt: NOW + HOUR_MS, refusedUntil: null })
    limited.rateLimitedUntil = NOW + HOUR_MS
    expect(fableSummary([limited], NOW)?.canTake).toBe(0)
    const loggedOut = sub('b', { usedFraction: 0.1, resetsAt: NOW + HOUR_MS, refusedUntil: null })
    loggedOut.tokenExpiresAt = NOW - 1
    expect(fableSummary([loggedOut], NOW)?.canTake).toBe(0)
    expect(
      fableSummary([sub('c', { usedFraction: 0.1, resetsAt: null, refusedUntil: null })], NOW)
        ?.canTake,
    ).toBe(1)
  })

  it('says how much of the Fable allowance is left, whatever the week leaves', () => {
    // Two weeks used up and one with room, no Fable spent: all of the allowance is left, one can take it.
    const profiles = [
      sub('a', { usedFraction: 0, resetsAt: NOW + HOUR_MS, refusedUntil: null }, 1),
      sub('b', { usedFraction: 0.02, resetsAt: NOW + HOUR_MS, refusedUntil: null }, 1),
      sub('c', { usedFraction: 0, resetsAt: NOW + HOUR_MS, refusedUntil: null }, 0.03),
    ]
    expect(fableSummary(profiles, NOW)).toEqual({
      withFable: 3,
      canTake: 1,
      left: expect.closeTo(0.9933, 3),
    })
  })

  it('sums the pool, leaving out seats without Fable', () => {
    const profiles = [
      sub('a', { usedFraction: 0.2, resetsAt: null, refusedUntil: null }),
      sub('b', { usedFraction: 1, resetsAt: NOW + HOUR_MS, refusedUntil: NOW + HOUR_MS }),
      sub('c', null),
    ]
    expect(fableSummary(profiles, NOW)).toEqual({ withFable: 2, canTake: 1, left: 0.4 })
    expect(fableSummary([sub('c', null)], NOW)).toBeNull()
  })
})

describe('the Fable allowance on the page', () => {
  const mount = (element: React.ReactElement) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(element))
    return container
  }
  const profiles = [
    sub('team-alpha', { usedFraction: 0.25, resetsAt: NOW + 40 * HOUR_MS, refusedUntil: null }),
    sub('team-bravo', {
      usedFraction: 1,
      resetsAt: NOW + 30 * HOUR_MS,
      refusedUntil: NOW + 30 * HOUR_MS,
    }),
    sub('team-charlie', null),
  ]

  it('gives a seat with Fable a Fable line on its week bar, says it, and details it', () => {
    const container = mount(<PoolAccounts profiles={profiles} now={NOW} />)
    const row = (name: string) =>
      [...container.querySelectorAll('.cmd-account')].find(
        (e) => e.querySelector('.cmd-account-name')?.textContent === name,
      ) as Element
    const bars = (name: string) =>
      [...row(name).querySelectorAll('[data-window]')].map((b) => b.getAttribute('data-window'))
    expect(bars('alpha')).toEqual(['weekly', 'fable', 'fiveHour'])
    expect(bars('charlie')).toEqual(['weekly', 'fiveHour'])
    expect(row('bravo').querySelector('[data-window="fable"]')?.getAttribute('data-level')).toBe(
      'full',
    )
    expect(row('alpha').textContent).toContain('Fable 75% left')
    expect(container.querySelector('.cmd-accounts-legend')?.textContent).toBe(
      'Bar: week left (line: Fable) · ring: 5 hours left',
    )

    act(() => (row('bravo').querySelector('button') as HTMLButtonElement).click())
    const detail = container.querySelector('.cmd-account-detail')?.textContent ?? ''
    expect(detail).toContain('Fable 100% used · resets in 1d 6h')
    expect(detail).toContain(
      'Anthropic refuses its Fable requests for 1d 6h; they go to other subscriptions, and it serves every other model',
    )
  })

  it('details a Fable allowance whose reset has passed as a new week, as the bar shows it', () => {
    const container = mount(
      <PoolAccounts
        profiles={[sub('team-delta', { usedFraction: 1, resetsAt: NOW - 1, refusedUntil: null })]}
        now={NOW}
      />,
    )
    expect(container.querySelector('[data-window="fable"]')?.getAttribute('data-level')).toBe('ok')
    act(() => (container.querySelector('.cmd-account button') as HTMLButtonElement).click())
    const detail = container.querySelector('.cmd-account-detail')?.textContent ?? ''
    expect(detail).toContain('Fable 0% used')
    expect(detail).not.toContain('Fable 100% used')
  })

  it('says how much Fable is left as the bar does, and when the week is what limits it', () => {
    // 10% of the week left is 20% of a Fable allowance that is half the week; 75% of the allowance is unused.
    const container = mount(
      <PoolAccounts
        profiles={[
          sub(
            'team-echo',
            { usedFraction: 0.25, resetsAt: NOW + 50 * HOUR_MS, refusedUntil: null },
            0.9,
          ),
        ]}
        now={NOW}
      />,
    )
    // On the bar, Fable's line is drawn in the week's units: never past what the week leaves.
    const left = (w: string) =>
      container.querySelector(`[data-window="${w}"]`)?.getAttribute('data-left')
    expect([left('weekly'), left('fable')]).toEqual(['10%', '10%'])
    act(() => (container.querySelector('.cmd-account button') as HTMLButtonElement).click())
    expect(container.querySelector('.cmd-account-detail')?.textContent).toContain(
      'Fable 25% used · the week leaves room for 20% more · resets with the week',
    )
  })

  it('says the week leaves no room when it rounds to nothing, not "room for 0% more"', () => {
    const container = mount(
      <PoolAccounts
        profiles={[
          sub(
            'team-india',
            { usedFraction: 0.25, resetsAt: NOW + 50 * HOUR_MS, refusedUntil: null },
            0.999,
          ),
        ]}
        now={NOW}
      />,
    )
    act(() => (container.querySelector('.cmd-account button') as HTMLButtonElement).click())
    const detail = container.querySelector('.cmd-account-detail')?.textContent ?? ''
    expect(detail).toContain('Fable 25% used · the week leaves no room for more')
    expect(detail).not.toContain('0% more')
  })

  it('keeps Fable as the week does while a 5-hour window holds the subscription: no talk of the week', () => {
    // 27% of the week used leaves room for more than the 69% of the allowance that is left.
    const held = {
      ...sub(
        'team-hotel',
        { usedFraction: 0.31, resetsAt: NOW + 50 * HOUR_MS, refusedUntil: null },
        0.27,
      ),
      rateLimitedUntil: NOW + 46 * 60_000,
    }
    const container = mount(<PoolAccounts profiles={[held]} now={NOW} />)
    // The bar still shows what is left this week, Fable's line included.
    expect(container.querySelector('[data-window="fable"]')?.getAttribute('data-left')).toBe(
      '34.5%',
    )
    act(() => (container.querySelector('.cmd-account button') as HTMLButtonElement).click())
    const detail = container.querySelector('.cmd-account-detail')?.textContent ?? ''
    expect(detail).toContain('Fable 31% used · resets with the week')
    expect(detail).not.toContain('room')
    // Right now it can take no Fable at all.
    expect(fableLeft(held, NOW)).toBe(0)
  })

  it("draws Fable's line at its share of the week: half the allowance left, in the week's units", () => {
    // 80% of the week left; half the Fable allowance left is a quarter of the week, inside the fill.
    const container = mount(
      <PoolAccounts
        profiles={[
          sub(
            'team-foxtrot',
            { usedFraction: 0.5, resetsAt: NOW + 50 * HOUR_MS, refusedUntil: null },
            0.2,
          ),
          sub('team-golf', null, 0.2),
        ]}
        now={NOW}
      />,
    )
    const line = container.querySelector<HTMLElement>('.cmd-meter-fable')
    expect(line?.getAttribute('data-left')).toBe('25%')
    expect(line?.style.left).toBe('25%')
    expect(line?.hidden).toBe(false)
    expect(container.querySelectorAll('.cmd-meter-fable')).toHaveLength(1)
    // A used-up allowance puts the line at the bar's start; a used-up week hides it.
    const out = mount(
      <PoolAccounts
        profiles={[
          sub(
            'team-hotel',
            { usedFraction: 1, resetsAt: NOW + 50 * HOUR_MS, refusedUntil: null },
            0.2,
          ),
          sub(
            'team-india',
            { usedFraction: 0.1, resetsAt: NOW + 50 * HOUR_MS, refusedUntil: null },
            1,
          ),
        ]}
        now={NOW}
      />,
    )
    const lines = [...out.querySelectorAll<HTMLElement>('.cmd-meter-fable')]
    expect(lines.map((l) => [l.style.left, l.hidden])).toEqual([
      ['0%', false],
      ['0%', true],
    ])
  })

  it('keeps the old legend when no subscription has Fable', () => {
    const container = mount(<PoolAccounts profiles={[sub('team-charlie', null)]} now={NOW} />)
    expect(container.querySelector('.cmd-accounts-legend')?.textContent).toBe(
      'Bar: week left · ring: 5 hours left',
    )
    expect(container.querySelector('[data-window="fable"]')).toBeNull()
  })

  it('says in the banner how much Fable the pool has', () => {
    const container = mount(<PoolOutlook gaps={null} profiles={profiles} now={NOW} />)
    expect(container.querySelector('.cmd-facts')?.textContent).toContain(
      'Fable: 1 of 2 can take it · 38% of their Fable allowance left',
    )
  })
})
