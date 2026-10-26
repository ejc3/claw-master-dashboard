// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DAY_MS,
  HOUR_MS,
  type PoolGaps,
  type ProfileStatus,
  poolGaps,
  WEEK_MS,
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
  // `null` for no replay: `undefined` would take the default.
  const render = (now: number, replay: typeof forecastWith | null = forecastWith) =>
    act(() =>
      root.render(
        <PollStoreContext.Provider value={store}>
          <ForecastHistory
            apiBase="/api"
            now={now}
            gaps={gaps}
            profiles={null}
            {...(replay == null ? {} : { forecastWith: replay })}
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
  it('charts running totals over the two weeks around now, never falling', async () => {
    const page = mount()
    page.render(T0)
    await page.settle()
    const tables = page.tables()
    expect(tables).toHaveLength(2)
    for (const rows of tables) {
      // Exactly a week either side of the clock, the clock, and every hour between.
      expect(rows).toHaveLength(2 * 168 + 3)
    }
    // Newest first: a running total never falls going back up the table's rows reversed.
    const blocked = (tables[1] ?? []).map((r) => Number.parseFloat(r[1] ?? '0')).reverse()
    for (let i = 1; i < blocked.length; i++)
      expect(blocked[i]).toBeGreaterThanOrEqual(blocked[i - 1] ?? 0)
  })

  it('adds the week ahead to last week, its gaps shaded and now marked on both charts', async () => {
    const gaps = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    const page = mount(gaps)
    page.render(T0)
    await page.settle()
    expect(
      [...page.container.querySelectorAll('.cmd-marker text')].map((t) => t.textContent),
    ).toEqual(['Now', 'Now'])
    const captions = [...page.container.querySelectorAll('figcaption')].map((f) => f.textContent)
    // a's reset in 10 hours throws away 40%; at 1% an hour its new week then runs out.
    expect(captions[0]).toMatch(/^Wasted at resets · \d+% last week · 40% next week$/)
    const hours = gaps.gaps.reduce(
      (sum, g) => sum + (Math.min(g.end ?? T0 + WEEK_MS, T0 + WEEK_MS) - g.start) / HOUR_MS,
      0,
    )
    expect(hours).toBeGreaterThan(10)
    expect(captions[1]).toMatch(new RegExp(`· ${Math.round(hours)}h next week$`))
    // Shaded on the time-without-tokens chart only.
    const [wastedChart, blockedChart] = [...page.container.querySelectorAll('figure')]
    expect(wastedChart?.querySelectorAll('.cmd-band')).toHaveLength(0)
    expect(blockedChart?.querySelectorAll('.cmd-band').length).toBeGreaterThanOrEqual(1)
    // Oldest first: 168 hours to 12:00, the clock (12:05) at 169, 13:00 at 170. The waste steps
    // up by 40% at the reset (22:05), so first at 23:00, index 180, and not before.
    const percent = (row: Array<string | null> | undefined) => Number.parseFloat(row?.[1] ?? '')
    const wasted = [...(page.tables()[0] ?? [])].reverse()
    expect(percent(wasted[179])).toBe(percent(wasted[169]))
    expect(percent(wasted[180]) - percent(wasted[169])).toBe(40)
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
    expect(tab('Like last 24 hours')?.getAttribute('aria-pressed')).toBe('true')
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
      'Wasted at resets · 40% next week',
    )
    expect(page.tables().at(-1)).toHaveLength(2 * 168 + 3)
  })

  it('forecasts with the last 24 hours replayed, or last week, once the readings are in', async () => {
    const gaps = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    const withWaste = (unused: number): PoolGaps => ({
      ...gaps,
      unusedAtReset: [{ profile: 'a', at: T0 + 10 * HOUR_MS, unused }],
    })
    // The last day's use repeats every day; last week's, with the demo's resets in it, does not.
    const daily = (paceAt: (t: number) => PoolGaps['pace']) => {
      for (let t = T0; t < T0 + WEEK_MS - DAY_MS; t += HOUR_MS) {
        if (paceAt(t).weekly !== paceAt(t + DAY_MS).weekly) return false
      }
      return true
    }
    const page = mount(gaps, (paceAt) => withWaste(daily(paceAt) ? 0.7 : 0.9))
    const title = () => page.container.querySelector('figcaption')?.textContent ?? ''
    page.hold()
    page.render(T0)
    await page.settle()
    page.letGo()
    await page.settle()
    expect(title()).toMatch(/^Wasted at resets · \d+% last week · 70% next week/)
    expect(page.container.textContent).toContain('Most wasted: a 70%')
    const tab = [...page.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Like last week',
    )
    act(() => tab?.click())
    expect(title()).toMatch(/^Wasted at resets · \d+% last week · 90% next week/)
    expect(page.container.textContent).toContain('Most wasted: a 90%')
  })

  it('shows the last 24 hours pressed when last week can no longer be replayed', async () => {
    const gaps = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    const page = mount(gaps, () => gaps)
    page.render(T0)
    await page.settle()
    const pressed = (name: string) =>
      [...page.container.querySelectorAll('button')]
        .find((b) => b.textContent === name)
        ?.getAttribute('aria-pressed')
    act(() =>
      [...page.container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Like last week')
        ?.click(),
    )
    expect(pressed('Like last week')).toBe('true')
    // The replay goes (here, no way to run it): the charts are at the headline's pace, the last
    // day's average, and the tab that shows pressed is the last day's.
    page.render(T0, null)
    await page.settle()
    expect(pressed('Like last 24 hours')).toBe('true')
    expect(pressed('Like last week')).toBe('false')
  })

  it('counts the week ahead to its very end: a late reset, and a gap the whole week', async () => {
    const base = poolGaps([halfUsed(T0)], T0, new Map([['a', 0.01]]), T0)
    const page = mount({
      ...base,
      gaps: [{ start: T0, end: null, endsWith: null }],
      unusedAtReset: [{ profile: 'a', at: T0 + WEEK_MS - 60_000, unused: 0.5 }],
    })
    page.render(T0)
    await page.settle()
    const captions = [...page.container.querySelectorAll('figcaption')].map((f) => f.textContent)
    expect(captions[0]).toMatch(/· 50% next week$/)
    expect(captions[1]).toMatch(/· 168h next week$/)
  })
})
