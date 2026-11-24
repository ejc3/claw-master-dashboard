// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOUR_MS, seriesQueryFromParams } from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { Breakdown } from '../src/react/Breakdown'
import { RANGES, rangeEnding } from '../src/react/queries'

const NOW = Date.UTC(2026, 10, 24, 12, 2)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  // jsdom has no ResizeObserver; the chart above the table stays unmeasured.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('shows each model its API cost while the Models table shows requests', async () => {
  // Tokens by model counted for the last two days only, as when the release that counts them came
  // partway through the week: the table shows requests, and the cost is partly estimated.
  const countedFrom = NOW - 48 * HOUR_MS
  const demo = createDemoSource({ now: () => NOW })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const query = seriesQueryFromParams(new URL(String(input), 'http://localhost').searchParams)
      const series = await demo.series(query)
      if (query.metric !== 'tokens' || query.groupBy !== 'model') return Response.json(series)
      return Response.json(
        series.map((s) => ({ ...s, points: s.points.filter(([t]) => t >= countedFrom) })),
      )
    }),
  )
  const week = RANGES['7d']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <Breakdown
        apiBase="/api"
        range={rangeEnding(NOW, week.ms, week.stepSeconds)}
        stepSeconds={week.stepSeconds}
        rangeWords="last 7 days"
        per={week.per}
        tokenChoice="all"
        now={NOW}
      />,
    )
    await vi.advanceTimersByTimeAsync(100)
  })
  const models = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Models')
  if (models === undefined) throw new Error('no Models tab')
  await act(async () => {
    models.click()
    await vi.advanceTimersByTimeAsync(100)
  })
  const heads = [...container.querySelectorAll('thead th')].map((e) => e.textContent)
  expect(heads).toEqual(['Model', 'Requests', 'API cost', 'Share', 'Trend'])
  const cells = [...container.querySelectorAll('tbody tr')].map((r) => r.children[2]?.textContent)
  expect(cells.length).toBeGreaterThan(0)
  for (const cell of cells) expect(cell).toMatch(/^\$[\d,.]+$/)
  expect(container.textContent).toMatch(/at Claude API prices, estimated from request counts/)
  act(() => root.unmount())
})
