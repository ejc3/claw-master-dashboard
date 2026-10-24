import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type CapacityAdvice,
  type EpochMs,
  extendHindcast,
  GAPS_HORIZON_MS,
  type HindcastPoint,
  HOUR_MS,
  hindcastTimes,
  type PoolGaps,
  type ProfileStatus,
  type QuotaHistory,
  type Series,
  wasteAndClipping,
} from '../core'
import { useReadings, useWhen } from './hooks'
import { type ChartSeries, LineChart } from './LineChart'
import { adviceLine, shortNames, unusedLine } from './Pool'
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
export function ForecastHistory(props: {
  apiBase: string
  now: EpochMs
  /** The forecast now (the headline's): the week ahead. */
  gaps: PoolGaps | null
  /** What to buy or cancel (capacityAdvice), when it has been worked out. */
  advice?: CapacityAdvice | null
  profiles: ProfileStatus[] | null
}) {
  const { apiBase, now, gaps } = props
  const when = useWhen()
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

  // One grid: each hour of the last week as its forecast saw the week ahead, then each hour of the
  // week ahead as the forecast now sees what is still to come from it, so the steps down show
  // when the waste and the clipping fall.
  const series: ChartSeries[] = useMemo(() => {
    if (points === null) return []
    const made = [...points.values()].filter((p): p is HindcastPoint => p !== null)
    const lastMade = made.at(-1)?.at ?? Number.NEGATIVE_INFINITY
    const ahead: HindcastPoint[] = []
    if (gaps !== null && gaps.lasts !== 'unknown' && gaps.lasts !== 'logins') {
      ahead.push(wasteAndClipping(gaps))
      const first = Math.floor(gaps.clock / HOUR_MS) * HOUR_MS + HOUR_MS
      for (let t = first; t <= gaps.clock + GAPS_HORIZON_MS; t += HOUR_MS) {
        ahead.push(wasteAndClipping(gaps, t))
      }
    }
    const all = [...made, ...ahead.filter((p) => p.at > lastMade)]
    return [
      {
        key: 'wasted',
        label: 'Wasted at resets',
        color: 'var(--cmd-series-3)',
        points: all.map((p): [EpochMs, number] => [p.at, p.wasted]),
      },
      {
        key: 'clipped',
        label: 'Clipped',
        color: 'var(--cmd-series-2)',
        points: all.map((p): [EpochMs, number] => [p.at, p.clipped]),
      },
    ]
  }, [points, gaps])

  const bands = useMemo(
    () =>
      (gaps?.gaps ?? []).map((g) => ({
        start: g.start,
        end: g.end ?? (gaps?.clock ?? 0) + GAPS_HORIZON_MS,
      })),
    [gaps],
  )
  // The week ahead as the forecast now sees it: each title's value.
  const ahead = useMemo(
    () =>
      gaps === null || gaps.lasts === 'unknown' || gaps.lasts === 'logins'
        ? null
        : wasteAndClipping(gaps),
    [gaps],
  )
  const names = shortNames((props.profiles ?? []).map((p) => p.profile))
  const clock = when === null ? null : (t: EpochMs) => when(t, now)
  const forecasting = gaps !== null && gaps.lasts !== 'unknown' && gaps.lasts !== 'logins'
  const lines = forecasting
    ? [unusedLine(gaps, names, clock), adviceLine(props.advice ?? null, names, now, clock)]
    : []

  return (
    <section className="cmd-forecast-history" aria-label="Waste and clipping">
      {series.length === 0 || (series[0]?.points.length ?? 0) < 2 ? (
        <p className="cmd-empty">Rebuilding last week's forecasts…</p>
      ) : (
        // One chart each, on the same time axis: a week of clipping can be ten subscriptions'
        // worth, and on its scale the waste would not show.
        series.map((s) => (
          <LineChart
            key={s.key}
            title={`${s.key === 'wasted' ? 'Wasted at resets' : 'Clipped'}${
              ahead === null
                ? ''
                : ` · ${asPercent(s.key === 'wasted' ? ahead.wasted : ahead.clipped)} ahead`
            }`}
            series={[s]}
            format={asPercent}
            height={140}
            now={now}
            bands={bands}
            bandLabel="No tokens forecast"
            area
            {...(gaps === null ? {} : { marker: { at: gaps.clock, label: 'Now' } })}
          />
        ))
      )}
      {lines.some((l) => l !== null) && (
        <ul className="cmd-facts cmd-forecast-facts">
          {lines
            .filter((l): l is string => l !== null)
            .map((line) => (
              <li key={line}>{line}</li>
            ))}
        </ul>
      )}
      <p className="cmd-capacity-note">
        Left of now: what each hour's forecast expected in its next week · right: what is still to
        come · 100% is one subscription's week · shaded: no tokens
      </p>
    </section>
  )
}
