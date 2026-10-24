'use client'

import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { type EpochMs, formatWhen } from '../core'
import { useWhen, useWidth } from './hooks'

export interface ChartSeries {
  key: string
  label: string
  /** A CSS color, normally from seriesColors. */
  color: string
  points: Array<[EpochMs, number]>
}

interface Props {
  title: string
  series: ChartSeries[]
  format: (value: number) => string
  /** Whole-number data (counts): axis ticks stay whole. */
  integer?: boolean
  height?: number
  /** Shade the area under a single line. */
  area?: boolean
  /** Clock for axis and tooltip labels. */
  now: EpochMs
  /** Spans of time shaded behind the lines (e.g. when no subscription can take work). */
  bands?: Array<{ start: EpochMs; end: EpochMs }>
  /** What a band means, said in the readout and as a table column ("No subscription can …"). */
  bandLabel?: string
  /** The axis maximum, when the scale is fixed (e.g. the pool's full capacity). */
  max?: number
  /** Offer the table view; off where a table of the samples tells nothing (the readout still does). */
  table?: boolean
  /** Stack the series as areas, each on the ones before it, so the top is their total. */
  stacked?: boolean
  /** A moment marked across the plot with a labelled line, e.g. where measured turns to forecast. */
  marker?: { at: EpochMs; label: string }
}

const PAD = { top: 8, right: 8, bottom: 22, left: 44 }
const LABEL_GUTTER = 72

/**
 * A clock time for an axis tick, short: a day's midnight is the day ("Tue 12:00 AM" → "Tue",
 * today's "Today"), and an hour on the hour drops its minutes ("6:00 PM" → "6 PM").
 */
export function axisTime(label: string): string {
  // Today's midnight has no day before it (formatWhen leaves today's off).
  if (label === '12:00 AM') return 'Today'
  const day = label.replace(/^(.+?),? 12:00 AM$/, '$1')
  return day !== label ? day : label.replace(/:00 (AM|PM)$/, ' $1')
}

/** How long a series takes to fade in or out when its legend entry is toggled. */
const TOGGLE_MS = 250

/**
 * Each series' weight, 1 shown and 0 hidden, easing between them over TOGGLE_MS when a series is
 * toggled (at once when the viewer prefers reduced motion): a stacked band shrinks away and the
 * ones above settle onto the ones below.
 */
function useWeights(keys: string[], off: ReadonlySet<string>): Map<string, number> {
  const target = (k: string) => (off.has(k) ? 0 : 1)
  const [weights, setWeights] = useState(() => new Map(keys.map((k) => [k, target(k)])))
  const current = useRef(weights)
  current.current = weights
  const keysKey = keys.join('\n')
  const offKey = [...off].sort().join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keys and off are read through their keys
  useEffect(() => {
    const goal = new Map(keys.map((k) => [k, target(k)]))
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const from = new Map(keys.map((k) => [k, current.current.get(k) ?? (goal.get(k) as number)]))
    if (reduce || keys.every((k) => from.get(k) === goal.get(k))) {
      setWeights(goal)
      return
    }
    let start: number | null = null
    let frame = 0
    const step = (t: number) => {
      start ??= t
      const p = Math.min(1, (t - start) / TOGGLE_MS)
      const eased = 1 - (1 - p) ** 3
      setWeights(
        new Map(
          keys.map((k) => {
            const a = from.get(k) as number
            return [k, a + ((goal.get(k) as number) - a) * eased]
          }),
        ),
      )
      if (p < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [keysKey, offKey])
  return weights
}

/** The smallest "nice" axis maximum at or above `max`; whole numbers when `integer`. */
export function niceMax(max: number, integer: boolean): number {
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude
    if (integer && !Number.isInteger(candidate)) continue
    if (candidate >= max) return candidate
  }
  return 10 * magnitude
}

/** Axis ticks: 0, the midpoint when it is a whole number (or the data is not counts), the top. */
export function valueTicks(max: number, integer: boolean): number[] {
  const mid = max / 2
  return !integer || Number.isInteger(mid) ? [0, mid, max] : [0, max]
}

/** Line chart with a crosshair readout (pointer, touch, or keyboard), legend and table view. */
export const LineChart = memo(function LineChart({
  title,
  series,
  format,
  integer = false,
  height = 200,
  area = false,
  now,
  bands = [],
  bandLabel = 'Shaded',
  table = true,
  stacked = false,
  max: fixedMax,
  marker,
}: Props) {
  const [ref, width] = useWidth<HTMLDivElement>()
  // Series turned off from the legend; at least one always stays on.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const weights = useWeights(
    series.map((s) => s.key),
    off,
  )
  const weightOf = (key: string) => weights.get(key) ?? 1
  const toggle = (key: string) =>
    setOff((o) => {
      const next = new Set(o)
      if (next.has(key)) next.delete(key)
      else if (series.some((s) => s.key !== key && !next.has(s.key))) next.add(key)
      return next
    })
  const when = useWhen()
  const [active, setActive] = useState<number | null>(null)
  const [touch, setTouch] = useState(false)
  const [showTable, setShowTable] = useState(false)
  const tableId = useId()
  const plotRef = useRef<HTMLDivElement>(null)

  // Every series is on the same grid (fillSeries); the first one carries the times.
  const times = series[0]?.points.map(([t]) => t) ?? []
  const directLabels = series.length > 1 && series.length <= 4 && width >= 360
  const right = PAD.right + (directLabels ? LABEL_GUTTER : 0)
  const plotWidth = Math.max(0, width - PAD.left - right)
  const plotHeight = height - PAD.top - PAD.bottom
  // Stacked, each series sits on the ones before it: its line is the running total.
  const tops = stacked
    ? series.reduce<number[][]>((acc, s, k) => {
        const w = weightOf(s.key)
        acc.push(s.points.map(([, v], i) => v * w + (k === 0 ? 0 : (acc[k - 1]?.[i] ?? 0))))
        return acc
      }, [])
    : series.map((s) => s.points.map(([, v]) => v))
  const max = fixedMax ?? niceMax(Math.max(0, ...tops.flat()), integer)
  const first = times[0] ?? 0
  const last = times[times.length - 1] ?? 1
  const x = (t: EpochMs) =>
    PAD.left + (last === first ? 0 : ((t - first) / (last - first)) * plotWidth)
  const y = (v: number) => PAD.top + plotHeight - (v / max) * plotHeight

  const pick = (clientX: number) => {
    const box = plotRef.current?.getBoundingClientRect()
    if (box === undefined || times.length === 0) return
    const t = first + ((clientX - box.left) / Math.max(1, box.width)) * (last - first)
    let best = 0
    for (let i = 1; i < times.length; i++) {
      if (Math.abs((times[i] ?? 0) - t) < Math.abs((times[best] ?? 0) - t)) best = i
    }
    setActive(best)
  }
  // A mouse reads wherever it hovers. A finger reads only where it taps: a touch that ends as a
  // tap (a scroll cancels it instead), so scrolling past a chart opens nothing.
  const onHover = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return
    setTouch(false)
    pick(event.clientX)
  }
  const onTap = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return
    setTouch(true)
    pick(event.clientX)
  }
  // A tapped readout stays until a tap anywhere else, as a popover does.
  const shown = active !== null && touch
  useEffect(() => {
    if (!shown) return
    const away = (event: Event) => {
      if (!plotRef.current?.contains(event.target as Node)) setActive(null)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [shown])
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (times.length === 0) return
    const lastIndex = times.length - 1
    const page = Math.max(1, Math.round(times.length / 12))
    const moves: Record<string, (i: number) => number> = {
      ArrowLeft: (i) => i - 1,
      ArrowRight: (i) => i + 1,
      PageUp: (i) => i - page,
      PageDown: (i) => i + page,
      Home: () => 0,
      End: () => lastIndex,
    }
    const move = moves[event.key]
    if (move !== undefined) {
      event.preventDefault()
      setActive((i) => Math.min(lastIndex, Math.max(0, move(i ?? lastIndex))))
    } else if (event.key === 'Escape') {
      setActive(null)
    }
  }

  const ticksY = valueTicks(max, integer)
  const ticksX = timeTicks(first, last, width < 480 ? 3 : 6)

  // Direct labels at each line's end, nudged apart so they never overlap.
  const ends = directLabels
    ? series
        .map((s, k) => ({ s, y: y(tops[k]?.[s.points.length - 1] ?? 0) }))
        .filter((e) => !off.has(e.s.key))
        .sort((a, b) => a.y - b.y)
        .map((e, i, all) => {
          const previous = all[i - 1]
          if (previous !== undefined && e.y - previous.y < 13) e.y = previous.y + 13
          return e
        })
    : []

  const activeTime = active === null ? null : (times[active] ?? null)
  const readIndex = active ?? times.length - 1
  const readTime = times[readIndex]
  // Wall-clock text waits for hydration: the server does not know the viewer's time zone.
  const inBand = (t: EpochMs) => bands.some((b) => t >= b.start && t < b.end)
  const valueText =
    readTime === undefined
      ? 'No data'
      : `${when === null ? 'Latest' : when(readTime, now)}: ${series
          .filter((s) => !off.has(s.key))
          .map((s) => `${s.label} ${format(s.points[readIndex]?.[1] ?? 0)}`)
          .join(', ')}${
          stacked && series.length > 1
            ? `, total ${format(tops[series.length - 1]?.[readIndex] ?? 0)}`
            : ''
        }${inBand(readTime) ? `; ${bandLabel}` : ''}`
  const tooltipLeft = activeTime === null ? 0 : x(activeTime)
  const flip = tooltipLeft > width / 2

  return (
    <figure className="cmd-panel" style={{ margin: 0 }}>
      <div className="cmd-panel-head">
        <figcaption className="cmd-panel-title">{title}</figcaption>
        {table && (
          <button
            type="button"
            className="cmd-toggle"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        )}
      </div>
      {series.length > 1 && (
        <ul className="cmd-legend">
          {series.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                className="cmd-legend-toggle"
                aria-pressed={!off.has(s.key)}
                title={off.has(s.key) ? `Show ${s.label}` : `Hide ${s.label}`}
                onClick={() => toggle(s.key)}
              >
                <span className="cmd-swatch" style={{ color: s.color }} />
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {showTable ? (
        <div className="cmd-table-wrap" id={tableId} style={{ maxHeight: 320 }}>
          <table className="cmd-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                {series.map((s) => (
                  <th scope="col" className="cmd-num" key={s.key}>
                    {s.label}
                  </th>
                ))}
                {bands.length > 0 && <th scope="col">{bandLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {times
                .map((t, i) => ({ t, i }))
                .reverse()
                .map(({ t, i }) => (
                  <tr key={t}>
                    <td>{formatWhen(t, now)}</td>
                    {series.map((s) => (
                      <td className="cmd-num" key={s.key}>
                        {format(s.points[i]?.[1] ?? 0)}
                      </td>
                    ))}
                    {bands.length > 0 && <td>{inBand(t) ? 'Yes' : ''}</td>}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        // The plot needs the measured width, so it draws once the page runs in the browser; its
        // height is held from the start, so nothing below moves when it does.
        <div className="cmd-chart" ref={ref} style={{ minHeight: height }}>
          {width > 0 && (
            <svg viewBox={`0 0 ${width} ${height}`} height={height} aria-hidden="true">
              {ticksY.map((v) => (
                <g key={v}>
                  <line
                    className="cmd-grid"
                    x1={PAD.left}
                    x2={PAD.left + plotWidth}
                    y1={y(v)}
                    y2={y(v)}
                  />
                  <text className="cmd-axis" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
                    {format(v)}
                  </text>
                </g>
              ))}
              {ticksX.map((t) => (
                <text
                  key={t}
                  className="cmd-axis"
                  x={x(t)}
                  y={height - 4}
                  textAnchor={
                    x(t) - PAD.left < 30
                      ? 'start'
                      : PAD.left + plotWidth - x(t) < 30
                        ? 'end'
                        : 'middle'
                  }
                >
                  {axisTime(formatWhen(t, now))}
                </text>
              ))}
              {bands.map((b) => {
                const from = x(Math.max(b.start, first))
                const to = x(Math.min(b.end, last))
                return to > from ? (
                  <rect
                    key={b.start}
                    className="cmd-band"
                    x={from}
                    y={PAD.top}
                    width={to - from}
                    height={plotHeight}
                  />
                ) : null
              })}
              {marker !== undefined && marker.at >= first && marker.at <= last && (
                <g className="cmd-marker">
                  <line
                    x1={x(marker.at)}
                    x2={x(marker.at)}
                    y1={PAD.top}
                    y2={PAD.top + plotHeight}
                  />
                  <text x={x(marker.at) + 4} y={PAD.top + 10}>
                    {marker.label}
                  </text>
                </g>
              )}
              {stacked &&
                series.map((s, k) => (
                  <polygon
                    key={`${s.key}-band`}
                    className="cmd-area cmd-area-stack"
                    fill={s.color}
                    points={[
                      ...s.points.map(([t], i) => `${x(t)},${y(tops[k]?.[i] ?? 0)}`),
                      ...s.points
                        .map(([t], i) => `${x(t)},${y(k === 0 ? 0 : (tops[k - 1]?.[i] ?? 0))}`)
                        .reverse(),
                    ].join(' ')}
                  />
                ))}
              {area &&
                !stacked &&
                series.length === 1 &&
                series.map((s) => (
                  <polygon
                    key={`${s.key}-area`}
                    className="cmd-area"
                    fill={s.color}
                    points={[
                      `${x(s.points[0]?.[0] ?? first)},${y(0)}`,
                      ...s.points.map(([t, v]) => `${x(t)},${y(v)}`),
                      `${x(s.points[s.points.length - 1]?.[0] ?? last)},${y(0)}`,
                    ].join(' ')}
                  />
                ))}
              {series.map((s, k) => (
                <polyline
                  key={s.key}
                  className="cmd-line"
                  fill="none"
                  stroke={s.color}
                  strokeWidth={stacked ? 1.5 : 2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={weightOf(s.key)}
                  points={s.points.map(([t], i) => `${x(t)},${y(tops[k]?.[i] ?? 0)}`).join(' ')}
                />
              ))}
              {ends.map(({ s, y: labelY }) => (
                <text
                  key={s.key}
                  className="cmd-end-label"
                  x={PAD.left + plotWidth + 6}
                  y={labelY + 4}
                >
                  {s.label}
                </text>
              ))}
              {activeTime !== null && (
                <g>
                  <line
                    x1={x(activeTime)}
                    x2={x(activeTime)}
                    y1={PAD.top}
                    y2={PAD.top + plotHeight}
                    stroke="var(--cmd-ink-3)"
                    strokeWidth={1}
                  />
                  {series.map((s, k) => {
                    const v = tops[k]?.[active ?? 0]
                    return v === undefined || off.has(s.key) ? null : (
                      <circle
                        key={s.key}
                        cx={x(activeTime)}
                        cy={y(v)}
                        r={4}
                        fill={s.color}
                        stroke="var(--cmd-surface)"
                        strokeWidth={2}
                      />
                    )
                  })}
                </g>
              )}
            </svg>
          )}
          {/* The readout control is HTML, outside the hidden drawing, so assistive technology
              reads its value; pointer, touch and keys all move the same crosshair. */}
          <div
            ref={plotRef}
            className="cmd-plot"
            style={{ left: PAD.left, top: PAD.top, width: plotWidth, height: plotHeight }}
            tabIndex={0}
            role="slider"
            aria-label={`${title}: read values over time`}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, times.length - 1)}
            aria-valuenow={Math.max(0, readIndex)}
            aria-valuetext={valueText}
            onPointerMove={onHover}
            onPointerDown={onHover}
            onPointerUp={onTap}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') setActive(null)
            }}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
          />
          {activeTime !== null && (
            <div
              className="cmd-tooltip"
              data-touch={touch}
              aria-hidden="true"
              style={
                // On touch it sits above the chart across its width, so the finger does not
                // hide it and a long label cannot run off the screen.
                touch
                  ? { left: 0, right: 0 }
                  : flip
                    ? { right: width - tooltipLeft + 10 }
                    : { left: tooltipLeft + 10 }
              }
            >
              {series
                .filter((s) => !off.has(s.key))
                .map((s) => (
                  <div className="cmd-tooltip-row" key={s.key}>
                    <span className="cmd-swatch" style={{ color: s.color }} />
                    {s.label}
                    <b>{format(s.points[active ?? 0]?.[1] ?? 0)}</b>
                  </div>
                ))}
              <div className="cmd-tooltip-time">{formatWhen(activeTime, now)}</div>
            </div>
          )}
        </div>
      )}
    </figure>
  )
})

const HOUR = 60 * 60 * 1000
const TICK_HOURS = [1, 2, 3, 6, 12, 24, 48]

/**
 * Ticks on round local hours (every 1, 2, 3, 6, 12, 24 or 48 hours), at most about `most` of
 * them. Built with local date arithmetic, so a daylight-saving change keeps them on the hour.
 */
export function timeTicks(first: EpochMs, last: EpochMs, most: number): EpochMs[] {
  if (last <= first) return []
  // Past the longest step, whole days: two at a time, or more where a span longer than a week
  // would put half again as many labels as asked for side by side.
  const days = Math.ceil((last - first) / (most * 1.5) / (24 * HOUR))
  const hours =
    TICK_HOURS.find((h) => (last - first) / (h * HOUR) <= most) ?? Math.max(48, days * 24)
  const every = Math.min(hours, 24)
  // The first local time at or after `from` that is on the hour and a multiple of the step.
  // Minutes are zeroed on every move: a daylight-saving jump can shift the clock by half an hour.
  const align = (from: EpochMs): Date => {
    const t = new Date(from)
    for (let k = 0; k < 96; k++) {
      t.setMinutes(0, 0, 0)
      if (t.getTime() >= from && t.getHours() % every === 0) break
      t.setTime(t.getTime() + HOUR)
    }
    return t
  }
  const ticks: EpochMs[] = []
  let t = align(first)
  for (let guard = 0; t.getTime() <= last && guard < 1000; guard++) {
    ticks.push(t.getTime())
    const next = new Date(t)
    if (hours >= 24) next.setDate(next.getDate() + hours / 24)
    else next.setHours(next.getHours() + hours)
    t = align(Math.max(next.getTime(), t.getTime() + HOUR))
  }
  return ticks
}

/** The color of the line that stands for several folded series. */
export const OTHER_COLOR = 'var(--cmd-ink-3)'
const SLOTS = 8

/**
 * A fixed color per entity: its position among all known names (sorted), so a series missing
 * from one range repaints no other. "Other" keeps its own neutral color. Should two shown
 * series land on the same slot (more than eight known), the later one takes a free slot.
 */
export function seriesColors(known: string[], shown: string[] = known): Map<string, string> {
  const universe = [...new Set(known.filter((k) => k !== 'Other'))].sort()
  const colors = new Map<string, string>()
  const used = new Set<number>()
  // Known keys first, each at its own slot, so a key outside the known ones (the paid API's
  // api-backup) never moves a subscription's color.
  const ordered = [...new Set(shown)].sort((a, b) => {
    const known = (k: string) => (universe.includes(k) ? 0 : 1)
    return known(a) - known(b) || a.localeCompare(b)
  })
  for (const key of ordered) {
    if (key === 'Other') {
      colors.set(key, OTHER_COLOR)
      continue
    }
    const index = universe.indexOf(key)
    let slot = (index < 0 ? universe.length : index) % SLOTS
    if (used.has(slot)) {
      const free = Array.from({ length: SLOTS }, (_, i) => i).find((i) => !used.has(i))
      if (free !== undefined) slot = free
    }
    used.add(slot)
    colors.set(key, `var(--cmd-series-${slot + 1})`)
  }
  return colors
}

/** At most `limit` series; the smallest of the rest fold into one "Other" line. */
export function foldSeries<T extends { key: string; points: Array<[EpochMs, number]> }>(
  series: T[],
  limit = 8,
): Array<{ key: string; points: Array<[EpochMs, number]> }> {
  if (series.length <= limit) return series
  const total = (s: T) => s.points.reduce((sum, [, v]) => sum + v, 0)
  const ranked = [...series].sort((a, b) => total(b) - total(a))
  const kept = ranked.slice(0, limit - 1)
  const rest = ranked.slice(limit - 1)
  const points = (rest[0]?.points ?? []).map(([t], i): [EpochMs, number] => [
    t,
    rest.reduce((sum, s) => sum + (s.points[i]?.[1] ?? 0), 0),
  ])
  return [...kept, { key: 'Other', points }]
}
