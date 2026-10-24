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
import { useReadings } from './hooks'
import { type ChartSeries, LineChart } from './LineChart'
import { historyQuery, READINGS_STEP_MS } from './queries'

const asPercent = (v: number) => `${Math.round(v * 100)}%`

/** Readings this close to the newest may still change (CloudWatch runs minutes behind). */
const UNSETTLED_MS = 2 * HOUR_MS

/**
 * What the forecast said, hour by hour over the last week, about the week ahead of it: how much
 * weekly resets would throw away, and how much demand no subscription could take. Rebuilt from
 * the quota readings, so it shows how the pace and the pool moved the outlook between the two.
 */
/**
 * One of the readings the forecasts are rebuilt from, as last answered, with the end of the range
 * that answer covers: while a moved range loads, the last answer stays, and covers less.
 */
function useHistory(
  apiBase: string,
  now: EpochMs,
  metric: Parameters<typeof historyQuery>[1],
): { series: Series[]; end: EpochMs } | null {
  const query = historyQuery(now, metric)
  const loaded = useReadings(apiBase, query)
  // The same object until a new answer comes, so what is worked out from it is not redone on
  // every render.
  const kept = useRef<{ series: Series[]; end: EpochMs } | null>(null)
  if (loaded.state === 'ready') {
    const end = loaded.range?.end ?? query.range.end
    if (kept.current?.series !== loaded.data || kept.current.end !== end) {
      kept.current = { series: loaded.data, end }
    }
  }
  return kept.current
}

/**
 * What the forecast said, hour by hour over the last week, about the week ahead of it: how much
 * weekly resets would throw away, and how much demand no subscription could take. Rebuilt from
 * the quota readings, so it shows how the pace and the pool moved the outlook between the two.
 */
export function ForecastHistory(props: { apiBase: string; now: EpochMs }) {
  const { apiBase, now } = props
  const weeklyUsed = useHistory(apiBase, now, 'weeklyUsed')
  const weeklyResets = useHistory(apiBase, now, 'weeklyResetsInSeconds')
  const fiveUsed = useHistory(apiBase, now, 'fiveHourUsed')
  const fiveResets = useHistory(apiBase, now, 'fiveHourResetsInSeconds')
  const [points, setPoints] = useState<Map<EpochMs, HindcastPoint | null> | null>(null)
  const kept = useRef<Map<EpochMs, HindcastPoint | null>>(new Map())
  useEffect(() => {
    if (weeklyUsed === null || weeklyResets === null || fiveUsed === null || fiveResets === null)
      return
    // A simulation a week long for each hour: after the page is up, and again only for the hours
    // new readings can change. Only to the end all four answers cover: an hour past it would be
    // worked out without its readings, and kept so once it settles.
    const end = Math.min(weeklyUsed.end, weeklyResets.end, fiveUsed.end, fiveResets.end)
    const timer = setTimeout(() => {
      const history: QuotaHistory = {
        stepMs: READINGS_STEP_MS,
        weeklyUsed: weeklyUsed.series,
        weeklyResetsInSeconds: weeklyResets.series,
        fiveHourUsed: fiveUsed.series,
        fiveHourResetsInSeconds: fiveResets.series,
      }
      const next = extendHindcast(kept.current, history, hindcastTimes(end), end - UNSETTLED_MS)
      kept.current = next
      setPoints(next)
    }, 0)
    return () => clearTimeout(timer)
  }, [weeklyUsed, weeklyResets, fiveUsed, fiveResets])

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
