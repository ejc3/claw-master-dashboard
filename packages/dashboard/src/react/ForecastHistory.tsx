import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type EpochMs,
  extendHindcast,
  type HindcastPoint,
  HOUR_MS,
  hindcastTimes,
  type QuotaHistory,
  type Series,
} from '../core'
import { useLastReady, useReadings } from './hooks'
import { type ChartSeries, LineChart } from './LineChart'
import { historyQuery } from './queries'

const asPercent = (v: number) => `${Math.round(v * 100)}%`

/** Readings this close to the newest may still change (CloudWatch runs minutes behind). */
const UNSETTLED_MS = 2 * HOUR_MS

/**
 * What the forecast said, hour by hour over the last week, about the week ahead of it: how much
 * weekly resets would throw away, and how much demand no subscription could take. Rebuilt from
 * the quota readings, so it shows how the pace and the pool moved the outlook between the two.
 */
export function ForecastHistory(props: { apiBase: string; now: EpochMs }) {
  const { apiBase, now } = props
  const weeklyUsed = useLastReady(useReadings(apiBase, historyQuery(now, 'weeklyUsed')))
  const weeklyResets = useLastReady(
    useReadings(apiBase, historyQuery(now, 'weeklyResetsInSeconds')),
  )
  const fiveUsed = useLastReady(useReadings(apiBase, historyQuery(now, 'fiveHourUsed')))
  const fiveResets = useLastReady(
    useReadings(apiBase, historyQuery(now, 'fiveHourResetsInSeconds')),
  )
  const query = historyQuery(now, 'weeklyUsed')
  const end = query.range.end
  const [points, setPoints] = useState<Map<EpochMs, HindcastPoint | null> | null>(null)
  const kept = useRef<Map<EpochMs, HindcastPoint | null>>(new Map())
  useEffect(() => {
    if (weeklyUsed === null || weeklyResets === null || fiveUsed === null || fiveResets === null)
      return
    // A simulation a week long for each hour: after the page is up, and again only for the hours
    // new readings can change.
    const timer = setTimeout(() => {
      const history: QuotaHistory = {
        stepMs: query.stepSeconds * 1000,
        weeklyUsed: weeklyUsed as Series[],
        weeklyResetsInSeconds: weeklyResets as Series[],
        fiveHourUsed: fiveUsed as Series[],
        fiveHourResetsInSeconds: fiveResets as Series[],
      }
      const next = extendHindcast(kept.current, history, hindcastTimes(end), end - UNSETTLED_MS)
      kept.current = next
      setPoints(next)
    }, 0)
    return () => clearTimeout(timer)
  }, [weeklyUsed, weeklyResets, fiveUsed, fiveResets, end, query.stepSeconds])

  const series: ChartSeries[] = useMemo(() => {
    if (points === null) return []
    const made = [...points.values()].filter((p): p is HindcastPoint => p !== null)
    return [
      {
        key: 'clipped',
        label: 'Clipped',
        color: 'var(--cmd-series-2)',
        points: made.map((p): [EpochMs, number] => [p.at, p.clipped]),
      },
      {
        key: 'wasted',
        label: 'Wasted at resets',
        color: 'var(--cmd-series-3)',
        points: made.map((p): [EpochMs, number] => [p.at, p.wasted]),
      },
    ]
  }, [points])

  return (
    <section className="cmd-forecast-history" aria-label="Forecasts over the last week">
      {series.length === 0 || (series[0]?.points.length ?? 0) < 2 ? (
        <p className="cmd-empty">Rebuilding last week's forecasts…</p>
      ) : (
        <LineChart
          title="Forecasts over the last week: clipped and wasted in the week ahead"
          series={series}
          format={asPercent}
          height={180}
          now={now}
        />
      )}
      <p className="cmd-capacity-note">
        Each hour, the forecast as it stood then · clipped: demand no subscription could take ·
        wasted: left unused when weeks reset · each subscription's week counts 100%
      </p>
    </section>
  )
}
