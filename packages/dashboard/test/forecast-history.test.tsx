// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS } from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { createDashboardHandler } from '../src/next/index'
import { ForecastHistory } from '../src/react/ForecastHistory'
import { createPollStore, PollStoreContext } from '../src/react/pollStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const T0 = Date.UTC(2026, 9, 20, 12, 5)
let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  vi.stubGlobal('ResizeObserver', SilentResizeObserver)
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
function mount() {
  let clock = T0
  const source = createDemoSource({ now: () => clock })
  const { GET } = createDashboardHandler({ source: () => source, authorize: () => true })
  let held = false
  const waiting: Array<() => void> = []
  const store = createPollStore(async (url) => {
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
          <ForecastHistory apiBase="/api" now={now} />
        </PollStoreContext.Provider>,
      ),
    )
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(() => vi.advanceTimersByTimeAsync(10))
  }
  const rows = () => {
    const toggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Show table',
    )
    if (toggle !== undefined) act(() => toggle.click())
    return [...container.querySelectorAll('tbody tr')].length
  }
  return {
    render,
    settle,
    rows,
    at: (t: number) => {
      clock = t
      vi.setSystemTime(t)
    },
    hold: () => {
      held = true
    },
    letGo: () => {
      held = false
      for (const resolve of waiting.splice(0)) resolve()
    },
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
})
