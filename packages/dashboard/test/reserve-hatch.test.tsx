// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS } from '../src/core/index'
import { LineChart } from '../src/react/LineChart'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FixedResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 600, height: 180 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0)
let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('ResizeObserver', FixedResizeObserver)
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("a reserve's hatch on a stacked chart", () => {
  it("hatches the bottom of a band up to its reserve, never above what is left, and only that band's", () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const at = (i: number) => NOW + i * HOUR_MS
    act(() =>
      root.render(
        <LineChart
          title="Weekly limit left"
          stacked
          max={2}
          now={NOW}
          format={(v) => `${Math.round(v * 100)}%`}
          series={[
            {
              key: 'a',
              label: 'a',
              color: 'red',
              points: [
                [at(0), 0.8],
                [at(1), 0.2],
              ],
              hatchBelow: 0.3,
            },
            {
              key: 'b',
              label: 'b',
              color: 'blue',
              points: [
                [at(0), 0.5],
                [at(1), 0.5],
              ],
            },
          ]}
        />,
      ),
    )
    const hatches = container.querySelectorAll<SVGPolygonElement>('.cmd-area-hatch')
    expect(hatches).toHaveLength(1)
    expect(hatches[0]?.getAttribute('data-series')).toBe('a')
    expect(hatches[0]?.getAttribute('fill')).toMatch(/^url\(#.+-hatch\)$/)
    expect(container.querySelector('pattern line.cmd-hatch-line')).not.toBeNull()
    // Its top: 0.3 while more is left, 0.2 (all that is left) after; its bottom the axis.
    const ys = (hatches[0]?.getAttribute('points') ?? '')
      .split(' ')
      .map((p) => Number(p.split(',')[1]))
    const band = container.querySelector<SVGPolygonElement>('.cmd-area-stack')
    const bandYs = (band?.getAttribute('points') ?? '')
      .split(' ')
      .map((p) => Number(p.split(',')[1]))
    const bottom = bandYs.at(-1) ?? 0
    const scale = (bottom - (bandYs[0] ?? 0)) / 0.8
    expect(ys[0]).toBeCloseTo(bottom - 0.3 * scale)
    expect(ys[1]).toBeCloseTo(bottom - 0.2 * scale)
    expect(ys.slice(2)).toEqual([bottom, bottom])
  })
})
