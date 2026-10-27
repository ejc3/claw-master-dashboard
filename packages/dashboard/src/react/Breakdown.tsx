'use client'

import { useMemo, useState } from 'react'
import {
  type EpochMs,
  formatCount,
  formatPercent,
  fromFirstBucket,
  type Series,
  type TimeRange,
  TOKEN_LABELS,
  TOKEN_TYPES,
  type TokenChoice,
  type TokenType,
  tokenChoiceLabel,
  tokenCoverage,
  tokenRows,
  tokensByType,
} from '../core/index'
import { useCountedSeries, useHeldHeight, useSeries, useWhen } from './hooks'
import { type ChartSeries, foldSeries, LineChart, seriesColors } from './LineChart'
import { shortNames } from './Pool'
import { breakdownQueries, SPLITS } from './queries'
import { Sparkline, sharedPeak } from './Sparkline'

function ShareCell(props: { share: number }) {
  return (
    <td>
      <span className="cmd-share-cell">
        <span className="cmd-share">
          <span style={{ width: `${props.share * 100}%` }} />
        </span>
        <span className="cmd-share-value">{formatPercent(props.share)}</span>
      </span>
    </td>
  )
}

/**
 * The range the table's title names: the chosen one, or "since 02:15" when the token counts start
 * partway through it, so the totals are not read as covering the whole range.
 */
export function tableRangeWords(
  coverage: 'none' | 'partial' | 'full' | null,
  firstAt: EpochMs | null,
  rangeWords: string,
  clock: ((at: EpochMs) => string) | null,
): string {
  if (coverage !== 'partial' || firstAt === null) return rangeWords
  return `since ${clock === null ? 'token counting began' : clock(firstAt)}`
}

/** One row per key with any requests in the range, most first. */
export function requestTable(series: Series[]): Array<Series & { total: number }> {
  return series
    .map((s) => ({ ...s, total: s.points.reduce((sum, [, v]) => sum + v, 0) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total)
}

/**
 * The rows as stacked chart series: each on one grid of every row's times (a row with no point at
 * a time is 0 there, so the bands add up to the total at every point), the smallest beyond eight
 * folded into Other, named by `labels`. A key in `known` (the page's subscription colors) keeps its
 * color; any other key takes a color from all the rows' keys, so a row folding into Other does not
 * repaint the rest. Past eight keys some share a slot, and the ones shown are kept apart first
 * (seriesColors' rule, as on the subscription chart), so a color can then move.
 */
export function stackedRows(
  rows: ReadonlyArray<{ key: string; points: ReadonlyArray<[EpochMs, number]> }>,
  labels: ReadonlyMap<string, string>,
  known?: ReadonlyMap<string, string>,
): ChartSeries[] {
  const times = [...new Set(rows.flatMap((r) => r.points.map(([t]) => t)))].sort((a, b) => a - b)
  const onGrid = rows.map((r) => {
    const byTime = new Map<EpochMs, number>()
    for (const [t, v] of r.points) byTime.set(t, (byTime.get(t) ?? 0) + v)
    return { key: r.key, points: times.map((t): [EpochMs, number] => [t, byTime.get(t) ?? 0]) }
  })
  const folded = foldSeries(onGrid)
  const shown = folded.map((r) => r.key)
  const free = seriesColors(known === undefined ? rows.map((r) => r.key) : [...known.keys()], shown)
  return folded.map((r) => ({
    key: r.key,
    label: labels.get(r.key) ?? r.key,
    color: known?.get(r.key) ?? free.get(r.key) ?? 'var(--cmd-ink-3)',
    points: r.points,
  }))
}

/** A row's name: in full, and on a phone without the prefix every subscription shares. */
function RowHead(props: { name: string; short: string; color: string | undefined }) {
  return (
    <th scope="row" className="cmd-row-head">
      {props.color !== undefined && (
        <span className="cmd-swatch" style={{ color: props.color }} aria-hidden="true" />
      )}
      {props.short === props.name ? (
        props.name
      ) : (
        <>
          <span className="cmd-full">{props.name}</span>
          <span className="cmd-phone">{props.short}</span>
        </>
      )}
    </th>
  )
}

/** Who and what used the pool in the range, one split at a time: tokens, or requests for models. */
export function Breakdown(props: {
  apiBase: string
  range: TimeRange
  stepSeconds: number
  /** The range in words, for the title ("last 24 hours"). */
  rangeWords: string
  /** Each point's width in words, for the chart's title ("per hour"). */
  per: string
  /** Which token type the share and trend columns use. */
  tokenChoice: TokenChoice
  now: EpochMs
  /** Each subscription's color, shown by its name when the table is split by subscription. */
  colors?: Map<string, string>
}) {
  const when = useWhen()
  const [split, setSplit] = useState(SPLITS[0] as (typeof SPLITS)[number])
  const queries = breakdownQueries(props.range, props.stepSeconds, split)
  const requests = useSeries(props.apiBase, queries.requests)
  // Every token type in one query, split the same way; none for models.
  const tokens = useCountedSeries(props.apiBase, queries.tokens)
  const typesReady = tokens.loaded.state === 'ready'
  const typeFailure = tokens.loaded.state === 'error' ? tokens.loaded : undefined
  const firstAt = tokens.firstAt
  const coverage = typesReady ? tokenCoverage(firstAt, props.range, props.stepSeconds) : null
  const showTokens = split.tokens && coverage !== null && coverage !== 'none'

  // Worked out again only when an answer or a choice changes, not on every tick of the clock.
  const tokenData = tokens.loaded.state === 'ready' ? tokens.loaded.data : null
  const typeData = useMemo(() => (tokenData === null ? null : tokensByType(tokenData)), [tokenData])
  const tokenTable = useMemo(
    () =>
      showTokens
        ? tokenRows(
            Object.fromEntries(
              TOKEN_TYPES.map((t) => {
                const series: Series[] = typeData?.[t] ?? []
                return [t, fromFirstBucket(series, firstAt, props.stepSeconds)]
              }),
            ) as Record<TokenType, Series[]>,
            props.tokenChoice,
          )
        : [],
    [showTokens, typeData, firstAt, props.stepSeconds, props.tokenChoice],
  )
  const requestData = requests.state === 'ready' ? requests.data : null
  const requestRows = useMemo(
    () => (requestData === null ? [] : requestTable(requestData)),
    [requestData],
  )
  // A token query that failed shows its error, never a quiet switch to requests.
  const tokenError =
    split.tokens && typeFailure !== undefined && typeFailure.state === 'error'
      ? typeFailure.failure
      : null
  const tokensPending = split.tokens && !typesReady && tokenError === null
  const rows = showTokens ? tokenTable : tokensPending || tokenError !== null ? [] : requestRows
  const all = rows.reduce((sum, r) => sum + r.total, 0)
  // One scale for every row's trend (the tallest bar of any row), so a small series does not
  // look as busy as a large one and the busiest row's peak fills its height.
  const peak = sharedPeak(rows)
  const short = useMemo(
    () =>
      split.dimension === 'profile'
        ? shortNames(rows.map((r) => r.key))
        : new Map<string, string>(),
    [rows, split.dimension],
  )
  const color = (key: string) =>
    split.dimension === 'profile' ? props.colors?.get(key) : undefined
  const stacked = useMemo(
    () => stackedRows(rows, short, split.dimension === 'profile' ? props.colors : undefined),
    [rows, short, split.dimension, props.colors],
  )

  const what = showTokens
    ? props.tokenChoice === 'all'
      ? 'Tokens'
      : `${tokenChoiceLabel(props.tokenChoice)} tokens`
    : 'Requests'
  const note = !split.tokens
    ? 'claw-master does not count tokens by model; this view counts requests.'
    : coverage === 'none'
      ? split.requests
        ? 'No token counts for this range yet; showing requests.'
        : `No token counts by ${split.noun} yet: claw-master releases that count them send them.`
      : null
  const loading = tokensPending || (!showTokens && split.requests && requests.state === 'loading')
  const requestsFailure =
    !showTokens && tokenError === null && requests.state === 'error' ? requests.failure : null
  const failure = tokenError ?? requestsFailure
  const [bodyRef, heldHeight] = useHeldHeight<HTMLDivElement>(loading)

  return (
    <section className="cmd-panel cmd-panel-flush" aria-labelledby="cmd-breakdown-title">
      <div className="cmd-panel-head cmd-panel-pad">
        <h2 className="cmd-panel-title" id="cmd-breakdown-title">
          {what} by {split.noun},{' '}
          {tableRangeWords(
            showTokens ? coverage : null,
            firstAt,
            props.rangeWords,
            when === null ? null : (at) => when(at, props.now),
          )}
        </h2>
      </div>
      <div className="cmd-panel-pad">
        <fieldset className="cmd-tabs">
          <legend className="cmd-visually-hidden">Split by</legend>
          {SPLITS.map((s) => (
            <button
              type="button"
              key={s.dimension}
              aria-pressed={s.dimension === split.dimension}
              onClick={() => setSplit(s)}
            >
              {s.shortLabel === s.label ? (
                s.label
              ) : (
                <>
                  <span className="cmd-full">{s.label}</span>
                  <span className="cmd-phone">{s.shortLabel}</span>
                </>
              )}
            </button>
          ))}
        </fieldset>
        {note !== null && <p className="cmd-note">{note}</p>}
      </div>
      {/* While another split or range loads, its body keeps the height the last one had. */}
      <div
        ref={bodyRef}
        className="cmd-breakdown-body"
        style={heldHeight === undefined ? undefined : { minHeight: heldHeight }}
      >
        {loading && <p className="cmd-empty cmd-panel-pad">Loading…</p>}
        {failure !== null && <p className="cmd-error cmd-panel-pad">{failure.message}</p>}
        {!loading && rows.length === 0 && failure === null && (
          <p className="cmd-empty cmd-panel-pad">Nothing in this range.</p>
        )}
        {rows.length > 0 && (
          <div className="cmd-panel-pad cmd-breakdown-chart">
            <LineChart
              title={`${what} ${props.per}, by ${split.noun}`}
              series={stacked}
              format={formatCount}
              integer
              height={180}
              now={props.now}
              stacked
            />
          </div>
        )}
        {rows.length > 0 && (
          <div className="cmd-table-wrap">
            <table className="cmd-table">
              <thead>
                <tr>
                  <th scope="col">
                    {split.shortColumn === split.column ? (
                      split.column
                    ) : (
                      <>
                        <span className="cmd-full">{split.column}</span>
                        <span className="cmd-phone">{split.shortColumn}</span>
                      </>
                    )}
                  </th>
                  {showTokens ? (
                    <>
                      {TOKEN_TYPES.map((t) => (
                        <th scope="col" className="cmd-num cmd-full" key={t}>
                          {TOKEN_LABELS[t]}
                        </th>
                      ))}
                      <th scope="col" className="cmd-num cmd-phone">
                        {what}
                      </th>
                    </>
                  ) : (
                    <th scope="col" className="cmd-num">
                      Requests
                    </th>
                  )}
                  <th scope="col">Share</th>
                  <th scope="col" className="cmd-full">
                    Trend
                  </th>
                </tr>
              </thead>
              <tbody>
                {showTokens
                  ? tokenTable.map((r) => (
                      <tr key={r.key}>
                        <RowHead
                          name={r.key}
                          short={short.get(r.key) ?? r.key}
                          color={color(r.key)}
                        />
                        {TOKEN_TYPES.map((t) => (
                          <td className="cmd-num cmd-full" key={t}>
                            {formatCount(r.byType[t])}
                          </td>
                        ))}
                        <td className="cmd-num cmd-phone">{formatCount(r.total)}</td>
                        <ShareCell share={all === 0 ? 0 : r.total / all} />
                        <td className="cmd-trend cmd-full">
                          <Sparkline points={r.points} maxBar={peak} />
                        </td>
                      </tr>
                    ))
                  : requestRows.map((r) => (
                      <tr key={r.key}>
                        <RowHead
                          name={r.key}
                          short={short.get(r.key) ?? r.key}
                          color={color(r.key)}
                        />
                        <td className="cmd-num">{formatCount(r.total)}</td>
                        <ShareCell share={all === 0 ? 0 : r.total / all} />
                        <td className="cmd-trend cmd-full">
                          <Sparkline points={r.points} maxBar={peak} />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
