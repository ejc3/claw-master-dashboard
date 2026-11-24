// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS, type ProfileStatus, poolGaps } from '../src/core/index'
import { LineChart } from '../src/react/LineChart'
import { CapacityOutlook, shorterNames } from '../src/react/Pool'

const NOW = Date.UTC(2026, 10, 24, 12, 2)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A ResizeObserver that reports one width, so a chart lays out as on a phone or a desktop.
let reportedWidth = 0
class FixedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(element: Element) {
    this.callback(
      [{ contentRect: { width: reportedWidth } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
    void element
  }
  unobserve() {}
  disconnect() {}
}

let roots: Root[] = []
beforeEach(() => {
  reportedWidth = 0
  vi.stubGlobal('ResizeObserver', FixedResizeObserver)
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  roots = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function render(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(node))
  return container
}

const profile = (name: string, fiveHour: boolean): ProfileStatus => ({
  profile: name,
  band: 'ok',
  weekly: { usedFraction: 0.5, resetsAt: NOW + 30 * HOUR_MS, lengthMs: 168 * HOUR_MS },
  fiveHour: fiveHour ? { usedFraction: 0.2, resetsAt: NOW + HOUR_MS, lengthMs: 5 * HOUR_MS } : null,
  rateLimitedUntil: null,
  tokenExpiresAt: null,
  latencyMs: { p50: null, p95: null, p99: null },
})

const outlook = (profiles: ProfileStatus[]) => {
  const pace = new Map(profiles.map((p) => [p.profile, 0.01] as const))
  return render(
    <CapacityOutlook gaps={poolGaps(profiles, NOW, pace, NOW)} profiles={profiles} now={NOW} />,
  )
}

const legend = (figure: Element) =>
  [...figure.querySelectorAll('.cmd-legend li')].map((li) => li.textContent)

describe('the 5-hour chart', () => {
  it('counts only the subscriptions that have a 5-hour limit', () => {
    // a has a 5-hour window; b and c (verified Ultra) have only a week, half of it left.
    const container = outlook([profile('a', true), profile('b', false), profile('c', false)])
    const figures = [...container.querySelectorAll('figure')]
    expect(figures.map((f) => f.querySelector('figcaption')?.textContent)).toEqual([
      'Weekly limit left · 150% of one subscription',
      // a's window has 80% left but its week only half: b's and c's weeks are not counted.
      '5-hour limit left, next 5h · 50% of one subscription',
    ])
    // Only a is drawn on it (one series: no legend).
    expect(legend(figures[1] as Element)).toEqual([])
    expect(container.querySelector('.cmd-capacity-note')?.textContent).toContain(
      'make 300% · 5-hour chart: only the 1 with a 5-hour limit · a 5-hour window',
    )
  })

  it('names each subscription it counts, and counts only those the forecast draws', () => {
    reportedWidth = 900
    // a and b have 5-hour limits, c has none, d's login has expired (the forecast leaves it out).
    const expired = { ...profile('d', true), tokenExpiresAt: NOW - HOUR_MS }
    const container = outlook([
      profile('a', true),
      profile('b', true),
      profile('c', false),
      expired,
    ])
    const figures = [...container.querySelectorAll('figure')]
    expect(legend(figures[0] as Element)).toEqual(['a', 'b', 'c'])
    expect(legend(figures[1] as Element)).toEqual(['a', 'b'])
    expect(figures[1]?.querySelector('figcaption')?.textContent).toBe(
      '5-hour limit left, next 5h · 100% of one subscription',
    )
    expect(container.querySelector('.cmd-capacity-note')?.textContent).toContain(
      'make 300% · 5-hour chart: only the 2 with a 5-hour limit ·',
    )
  })

  it('is left out when no subscription has a 5-hour limit', () => {
    const container = outlook([profile('a', false), profile('b', false)])
    expect(
      [...container.querySelectorAll('figure')].map(
        (f) => f.querySelector('figcaption')?.textContent,
      ),
    ).toEqual(['Weekly limit left · 100% of one subscription'])
    expect(container.querySelector('.cmd-capacity-note')?.textContent).not.toContain(
      '5-hour chart:',
    )
  })

  it('counts every subscription when all have a 5-hour limit, and says nothing of it', () => {
    const container = outlook([profile('a', true), profile('b', true)])
    const figures = [...container.querySelectorAll('figure')]
    expect(figures[1]?.querySelector('figcaption')?.textContent).toBe(
      '5-hour limit left, next 5h · 100% of one subscription',
    )
    expect(container.querySelector('.cmd-capacity-note')?.textContent).toContain(
      'make 200% · a 5-hour window',
    )
  })
})

describe('shorterNames', () => {
  it('drops a renewal suffix where each name stays its own', () => {
    const names = [
      'claude-alpha-2-renewed-20261121',
      'claude-alpha-renewed-20261112',
      'claude-bravo-renewed',
      'claude-bravo-mail-renewed-20261118',
      'claude-delta',
      'claude-delta-renewed-20261112',
    ]
    expect([...shorterNames(names).values()]).toEqual([
      'alpha-2',
      'alpha',
      'bravo',
      'bravo-mail',
      // Both would be "delta": each keeps its short name.
      'delta',
      'delta-renewed-20261112',
    ])
  })

  it('keeps the plain short names when a fallback would meet another name', () => {
    // alpha and alpha-renewed both cut to "alpha", so fall back; alpha-renewed-renewed cuts to
    // "alpha-renewed", which is then taken twice.
    const names = ['p-alpha', 'p-alpha-renewed', 'p-alpha-renewed-renewed']
    expect([...shorterNames(names).values()]).toEqual([
      'alpha',
      'alpha-renewed',
      'alpha-renewed-renewed',
    ])
  })
})

describe('a chart legend', () => {
  const series = [
    { key: 'x', label: 'alpha-2-renewed-20261121', shortLabel: 'alpha-2', color: 'red' },
    { key: 'y', label: 'bravo-renewed', shortLabel: 'bravo', color: 'blue' },
  ].map((s) => ({
    ...s,
    points: [
      [NOW, 1],
      [NOW + HOUR_MS, 0.5],
    ] as Array<[number, number]>,
  }))
  const chart = () =>
    render(<LineChart title="Left" series={series} format={String} now={NOW} table={false} />)

  it('uses the short names on a phone', () => {
    reportedWidth = 380
    const figure = chart().querySelector('figure') as Element
    expect(legend(figure)).toEqual(['alpha-2', 'bravo'])
  })

  it('keeps the full names on a wide screen', () => {
    reportedWidth = 900
    const figure = chart().querySelector('figure') as Element
    expect(legend(figure)).toEqual(['alpha-2-renewed-20261121', 'bravo-renewed'])
  })
})
