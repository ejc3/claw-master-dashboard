// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS, hasHeadroom, type ProfileStatus } from '../src/core/index'
import { createResetScenarioSource, RESET_CYCLE_MS, scenarioResetAt } from '../src/demo/reset'
import { createDashboardHandler, DashboardPage, firstSegmentUnder } from '../src/next/index'
import { forecastClock } from '../src/react/Dashboard'
import { PoolAccounts, SPARKLE_MS } from '../src/react/Pool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Five seconds before a loop's reset.
const RESET = scenarioResetAt(Date.UTC(2026, 9, 9, 18, 2, 0))
const BEFORE = RESET - 5_000
let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: BEFORE })
  vi.stubGlobal('ResizeObserver', SilentResizeObserver)
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const sub = (name: string, fiveUsed: number, resetsAt: number): ProfileStatus => ({
  profile: name,
  band: 'ok',
  weekly: { usedFraction: 0.5, resetsAt: BEFORE + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
  fiveHour: { usedFraction: fiveUsed, resetsAt, lengthMs: 5 * HOUR_MS },
  // A used-up window is out only because Anthropic refuses it, until the window resets.
  rateLimitedUntil: fiveUsed >= 1 ? resetsAt : null,
  tokenExpiresAt: null,
  latencyMs: { p50: null, p95: null, p99: null },
})

describe('forecastClock', () => {
  it('is the minute, or a reset that passed since the minute began', () => {
    const minute = Math.floor(BEFORE / 60_000) * 60_000
    const p = sub('a', 1, BEFORE + 2_000)
    expect(forecastClock([p], BEFORE)).toBe(minute)
    expect(forecastClock([p], BEFORE + 3_000)).toBe(BEFORE + 2_000)
    expect(forecastClock([{ ...p, rateLimitedUntil: BEFORE + 2_500 }], BEFORE + 3_000)).toBe(
      BEFORE + 2_500,
    )
    expect(forecastClock(null, BEFORE)).toBe(minute)
  })
})

describe('the sparkle when quota returns', () => {
  it('plays once on a subscription that takes work again, and not on the first render', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const profiles = [sub('alpha', 1, BEFORE + 2_000), sub('bravo', 0.2, BEFORE + HOUR_MS)]
    const render = (now: number) =>
      act(() => root.render(<PoolAccounts profiles={profiles} now={now} />))
    render(BEFORE)
    // bravo was available all along: nothing sparkles on the first render.
    expect(container.querySelectorAll('.cmd-sparkle')).toHaveLength(0)
    render(BEFORE + 1_000)
    expect(container.querySelectorAll('.cmd-sparkle')).toHaveLength(0)
    // alpha's window resets: it sparkles, bravo does not.
    render(BEFORE + 2_000)
    const sparkling = [...container.querySelectorAll('.cmd-account')].filter(
      (e) => e.querySelector('.cmd-sparkle') !== null,
    )
    expect(sparkling.map((e) => e.querySelector('.cmd-account-name')?.textContent)).toEqual([
      'alpha',
    ])
    expect(sparkling[0]?.querySelectorAll('.cmd-sparkle svg')).toHaveLength(4)
    // Still playing a second later, gone once it has played.
    render(BEFORE + 3_000)
    expect(container.querySelectorAll('.cmd-sparkle')).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(SPARKLE_MS)
    })
    expect(container.querySelectorAll('.cmd-sparkle')).toHaveLength(0)
  })
})

describe('the reset scenario', () => {
  it('is out until alpha resets two and a half minutes into each loop, then alpha takes work', async () => {
    const at = (t: number) => createResetScenarioSource({ now: () => t }).snapshot()
    const before = await at(BEFORE)
    expect(before.profiles.filter((p) => hasHeadroom(p, BEFORE))).toHaveLength(0)
    expect(before.profiles[0]?.fiveHour?.resetsAt).toBe(RESET)
    const after = await at(RESET + 1_000)
    expect(
      after.profiles.filter((p) => hasHeadroom(p, RESET + 1_000)).map((p) => p.profile),
    ).toEqual([after.profiles[0]?.profile])
    // The next loop is out again, counting down to its own reset.
    const next = await at(RESET + RESET_CYCLE_MS - 30_000)
    expect(next.profiles[0]?.fiveHour?.resetsAt).toBe(RESET + RESET_CYCLE_MS)
  })

  it('turns the banner the second the countdown reaches zero, and sparkles', async () => {
    const source = createResetScenarioSource({ now: () => Date.now() })
    const { GET } = createDashboardHandler({ source: () => source, authorize: () => true })
    // Polls are answered, but nothing reloads the snapshot in the five seconds that matter.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => GET(new Request(new URL(url, 'https://dashboard.example')))),
    )
    const element = (await DashboardPage({
      source: () => source,
      authorize: () => true,
      unauthorized: null,
      apiBase: '/api/claude-master',
      timeZone: 'UTC',
      keepAlive: () => {},
    })) as ReactElement
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    document.body.append(container)
    act(() => {
      roots.push(hydrateRoot(container, element))
    })
    const headline = () => container.querySelector('#cmd-pool-headline')?.textContent ?? ''
    expect(headline()).toMatch(/^Out now/)
    expect(headline()).toContain('back in 5s')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    expect(headline()).toContain('back in 1s')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(headline()).not.toMatch(/^Out now/)
    expect(container.querySelectorAll('.cmd-sparkle')).toHaveLength(1)
    // The 5-hour chart says what is left now, not the sample before: alpha's whole window, as far
    // as the 40% its week leaves.
    const fiveHourTitle = [...container.querySelectorAll('figcaption')]
      .map((e) => e.textContent ?? '')
      .find((t) => t.startsWith('5-hour limit left'))
    expect(fiveHourTitle).toBe('5-hour limit left, next 5h · 40% of one subscription')
  })
})

describe('firstSegmentUnder', () => {
  it('names the dashboard a request is for, decoded, and nothing outside the mount', () => {
    const base = '/api/claude-master'
    const at = (path: string) => firstSegmentUnder(`https://dashboard.example${path}`, base)
    expect(at('/api/claude-master/try-reset/snapshot')).toBe('try-reset')
    // An escaped name is the same name: never the live data under the scenario's address.
    expect(at('/api/claude-master/try%2Dreset/snapshot')).toBe('try-reset')
    expect(at('/api/claude-master/snapshot')).toBe('snapshot')
    expect(at('/api/claude-master/%E0%A4%A/snapshot')).toBe('')
    expect(at('/api/claude-masterx/try-reset/snapshot')).toBe('')
  })
})

describe('the sparkle, again', () => {
  it('starts over when a subscription returns a second time while it plays', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const out = [sub('alpha', 1, BEFORE + HOUR_MS)]
    const back = [sub('alpha', 0.2, BEFORE + HOUR_MS)]
    const render = (profiles: ProfileStatus[]) =>
      act(() => root.render(<PoolAccounts profiles={profiles} now={BEFORE} />))
    render(out)
    render(back)
    const first = container.querySelector('.cmd-sparkle')
    expect(first).not.toBeNull()
    render(out)
    render(back)
    const second = container.querySelector('.cmd-sparkle')
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })
})
