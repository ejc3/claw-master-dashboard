// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOUR_MS,
  type PoolGaps,
  type ProfileStatus,
  poolGaps,
  WEEK_MS,
  wasteAndClipping,
} from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { createDashboardHandler } from '../src/next/index'
import { ForecastHistory } from '../src/react/ForecastHistory'
import { createPollStore, PollStoreContext } from '../src/react/pollStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Every chart is 600 pixels wide, so it draws. */
class WideResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [{ contentRect: { width: 600 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}

const T0 = Date.UTC(2026, 9, 20, 12, 5)
let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  vi.stubGlobal('ResizeObserver', WideResizeObserver)
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * The section on the demo source, through the real handler. While `held`, a request goes
 * unanswered until it is let go, as a page coming back from the background waits on its moved
 * ranges.
 */
function mount(
  gaps: PoolGaps | null = null,
  forecastWith?: (paceAt: (t: number) => PoolGaps['pace']) => PoolGaps,
) {
  let clock = T0
  const source = createDemoSource({ now: () => clock })
  const { GET } = createDashboardHandler({ source: () => source, authorize: () => true })
  let held = false
  let failing = false
  const waiting: Array<() => void> = []
  const store = createPollStore(async (url) => {
    if (failing) return new Response('{"error":"down"}', { status: 502 })
    if (held) await new Promise<void>((resolve) => waiting.push(resolve))
    return GET(new Request(`http://dashboard.test${url}`))
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const render = (now: number) =>
    act(() =>
      root.render(
        <PollStoreContext.Provider value={store}>
          <ForecastHistory
            apiBase="/api"
            now={now}
            gaps={gaps}
            profiles={null}
            {...(forecastWith === undefined ? {} : { forecastWith })}
          />
        </PollStoreContext.Provider>,
      ),
    )
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(() => vi.advanceTimersByTimeAsync(10))
  }
  // Every chart's table, opened: the rows of each, newest first.
  const tables = () => {
    for (const toggle of [...container.querySelectorAll('button')]) {
      if (toggle.textContent === 'Show table') act(() => toggle.click())
    }
    return [...container.querySelectorAll('table')].map((t) =>
      [...t.querySelectorAll('tbody tr')].map((r) =>
        [...r.querySelectorAll('td')].map((c) => c.textContent),
      ),
    )
  }
  // The clipping chart's rows: one an hour (the waste chart adds its resets' spikes).
  const rows = () => tables().at(-1)?.length ?? 0
  return {
    render,
    settle,
    rows,
    tables,
    container,
    at: (t: number) => {
      clock = t
      vi.setSystemTime(t)
    },
    hold: () => {
      held = true
    },
    fail: () => {
      failing = true
    },
    letGo: () => {
      held = false
      for (const resolve of waiting.splice(0)) resolve()
    },
  }
}

/** One subscription half used, resetting 10 hours after `at`: at 1% an hour, 40% thrown away. */
function halfUsed(at: number): ProfileStatus {
  return {
    profile: 'a',
    band: 'ok',
    weekly: { usedFraction: 0.5, resetsAt: at + 10 * HOUR_MS, lengthMs: WEEK_MS },
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
  }
}

describe('ForecastHistory', () => {
  it('charts an hour of every hour of the last week', async () => {
    const page = mount()
    page.render(T0)
    await page.settle()
    expect(page.rows()).toBe(169)
  })

  it('works out the hours it missed while away once their readings arrive', async () => {
    const page = mount()
    page.render(T0)
    await page.settle()
    // Back eight hours later: the moved ranges load while the old answers show.
    page.hold()
    const later = T0 + 8 * HOUR_MS
    page.at(later)
    page.render(later)
    await page.settle()
    page.letGo()
    await page.settle()
    expect(page.rows()).toBe(169)
  })

  it('goes on a week ahead from the forecast now, with its gaps shaded and now marked', async () => {
    // One subscription half used, resetting in 10 hours at 1% an hour: 40% thrown away then.
    const profile: ProfileStatus = {
      profile: 'a',
      band: 'ok',
      weekly: { usedFraction: 0.5, resetsAt: T0 + 10 * HOUR_MS, lengthMs: WEEK_MS },
      fiveHour: null,
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const gaps = poolGaps([profile], T0, new Map([['a', 0.01]]), T0)
    const page = mount(gaps)
    page.render(T0)
    await page.settle()
    // Both charts mark now and shade the forecast's gaps.
    expect(
      [...page.container.querySelectorAll('.cmd-marker text')].map((t) => t.textContent),
    ).toEqual(['Now', 'Now'])
    expect(gaps.gaps.length).toBeGreaterThan(0)
    expect(page.container.querySelectorAll('.cmd-band')).toHaveLength(2 * gaps.gaps.length)
    const [wasted, clipped] = page.tables()
    // 169 hours back, the forecast's own clock, and every hour of the week ahead after it.
    expect(clipped).toHaveLength(169 + 1 + 168)
    expect(clipped?.[0]?.[1]).toBe('0%')
    // At 1% an hour the new week runs out about 100 hours after the reset: that gap is clipped.
    const now = wasteAndClipping(gaps)
    expect(now.clippedHours).toBeGreaterThan(50)
    expect(clipped?.[168]?.[1]).toBe(`${Math.round(now.clipped * 100)}%`)
    // The waste is a spike at the reset, 10 hours on, and nothing either side of it.
    const spike = wasted?.findIndex((row) => row[1] === '40%') ?? -1
    expect(spike).toBeGreaterThan(0)
    expect(wasted?.[spike - 1]?.[1]).toBe('0%')
    expect(wasted?.[spike + 1]?.[1]).toBe('0%')
    expect(page.container.querySelector('figcaption')?.textContent).toMatch(
      /^Wasted at resets · 40% ahead · \d+% last week$/,
    )
  })

  it('takes the forecast now at its own clock over a rebuilt hour at the same time', async () => {
    const onHour = Date.UTC(2026, 9, 20, 12)
    const gaps = poolGaps([halfUsed(onHour)], onHour, new Map([['a', 0.01]]), onHour)
    const page = mount(gaps)
    page.render(T0)
    await page.settle()
    const clipped = page.tables().at(-1)
    // 168 rebuilt hours before 12:00, then 12:00 and every hour of the week ahead.
    expect(clipped).toHaveLength(168 + 1 + 168)
    expect(clipped?.[168]?.[1]).toBe(`${Math.round(wasteAndClipping(gaps).clipped * 100)}%`)
  })

  it('holds the charts back, with the tabs up, until last week is worked out', async () => {
    const gaps = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    const page = mount(gaps, () => gaps)
    page.hold()
    page.render(T0)
    await page.settle()
    // No half-drawn pair: a placeholder holds their place.
    expect(page.container.querySelectorAll('figure')).toHaveLength(0)
    expect(page.container.querySelector('.cmd-forecast-loading')).not.toBeNull()
    const tab = (name: string) =>
      [...page.container.querySelectorAll('button')].find((b) => b.textContent === name)
    expect(tab('Current pace')?.getAttribute('aria-pressed')).toBe('true')
    expect(tab('Like last week')?.disabled).toBe(true)
    page.letGo()
    await page.settle()
    expect(page.container.querySelectorAll('figure')).toHaveLength(2)
    expect(tab('Like last week')?.disabled).toBe(false)
  })

  it("shows the week ahead and its title's value when last week's readings fail", async () => {
    const gaps = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    const page = mount(gaps)
    page.fail()
    page.render(T0)
    await page.settle()
    expect(page.container.querySelector('figcaption')?.textContent).toBe(
      'Wasted at resets · 40% ahead',
    )
    expect(page.tables().at(-1)).toHaveLength(1 + 168)
  })

  it('switches the week ahead to last week replayed, once last week is in', async () => {
    const gaps = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    const paces: Array<(t: number) => PoolGaps['pace']> = []
    const replayed: PoolGaps = {
      ...gaps,
      unusedAtReset: [{ profile: 'a', at: T0 + 10 * HOUR_MS, unused: 0.9 }],
    }
    const page = mount(gaps, (paceAt) => {
      paces.push(paceAt)
      return replayed
    })
    page.render(T0)
    await page.settle()
    const title = () => page.container.querySelector('figcaption')?.textContent ?? ''
    expect(title()).toMatch(/^Wasted at resets · 40% ahead/)
    const tab = [...page.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Like last week',
    )
    expect(tab).toBeDefined()
    // The pace it was given is last week's, an hour at a time.
    expect(paces.length).toBeGreaterThan(0)
    expect(paces.at(-1)?.(T0).weekly).toBeGreaterThanOrEqual(0)
    act(() => tab?.click())
    expect(title()).toMatch(/^Wasted at resets · 90% ahead/)
    expect(page.container.textContent).toContain('Most wasted: a 90%')
  })

  it('puts both charts on one time axis when a reset falls past the last hour', async () => {
    const gaps = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    // A reset a minute before the horizon: after the last whole hour the clipping chart has.
    const late: PoolGaps = {
      ...gaps,
      unusedAtReset: [{ profile: 'a', at: T0 + WEEK_MS - 60_000, unused: 0.5 }],
    }
    const page = mount(late)
    page.render(T0)
    await page.settle()
    const nows = [...page.container.querySelectorAll('.cmd-marker line')].map((l) =>
      l.getAttribute('x1'),
    )
    expect(nows).toHaveLength(2)
    expect(nows[0]).toBe(nows[1])
  })
})
