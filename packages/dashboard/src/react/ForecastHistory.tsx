import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type CapacityAdvice,
  type EpochMs,
  extendHindcast,
  GAPS_HORIZON_MS,
  HINDCAST_SPAN_MS,
  type HindcastPoint,
  HOUR_MS,
  hindcastTimes,
  measuredResets,
  type PoolGaps,
  type ProfileStatus,
  type QuotaHistory,
  resetSpikes,
  type Series,
  wasteAndClipping,
  weekAgoPace,
  weekPerFiveHourWindow,
} from '../core'
import { useReadings, useWhen } from './hooks'
import { type ChartSeries, LineChart } from './LineChart'
import { adviceLine, shortNames, unusedLine } from './Pool'
import { historyQuery, READINGS_STEP_MS } from './queries'

const asPercent = (v: number) => `${Math.round(v * 100)}%`

/** Whether a forecast says anything (a reading and a login to go on). */
const forecastingGaps = (gaps: PoolGaps | null): gaps is PoolGaps =>
  gaps !== null && gaps.lasts !== 'unknown' && gaps.lasts !== 'logins'

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
  /**
   * The headline's forecast run again at a pace that changes hour by hour (poolGaps' paceAt), for
   * the week ahead like last week. Without it, only the current pace is shown.
   */
  forecastWith?: (paceAt: (t: EpochMs) => PoolGaps['pace']) => PoolGaps
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

  // Two forecasts of the week ahead: the headline's, at the current pace, and one that replays
  // last week hour by hour (from the same readings, once they are in).
  const [model, setModel] = useState<'pace' | 'lastWeek'>('pace')
  const { forecastWith } = props
  const lastWeekPace = useMemo(() => {
    if (weeklyUsed === null || fiveUsed === null) return null
    const end = Math.min(weeklyUsed.end, fiveUsed.end)
    return weekAgoPace(
      weeklyUsed.series,
      weekPerFiveHourWindow(weeklyUsed.series, fiveUsed.series, end),
    )
  }, [weeklyUsed, fiveUsed])
  const lastWeekGaps = useMemo(
    () =>
      forecastWith === undefined || lastWeekPace === null || !forecastingGaps(gaps)
        ? null
        : forecastWith(lastWeekPace),
    [forecastWith, lastWeekPace, gaps],
  )
  const likeLastWeek = model === 'lastWeek' && lastWeekGaps !== null && lastWeekPace !== null
  const shown = likeLastWeek ? lastWeekGaps : gaps
  const paceAt = likeLastWeek ? lastWeekPace : undefined

  // One grid: each hour of the last week as its forecast saw the week ahead, then each hour of the
  // week ahead as the chosen forecast sees what is still to come from it, so the steps down show
  // when the clipping falls. The waste chart draws its resets on the same grid.
  const series: ChartSeries[] = useMemo(() => {
    // The week ahead does not wait on last week's readings, nor fail with them.
    const made = [...(points?.values() ?? [])].filter((p): p is HindcastPoint => p !== null)
    const ahead: HindcastPoint[] = []
    if (forecastingGaps(shown)) {
      ahead.push(wasteAndClipping(shown, shown.clock, paceAt))
      const first = Math.floor(shown.clock / HOUR_MS) * HOUR_MS + HOUR_MS
      for (let t = first; t <= shown.clock + GAPS_HORIZON_MS; t += HOUR_MS) {
        ahead.push(wasteAndClipping(shown, t, paceAt))
      }
    }
    // The forecast now, from its own clock on: a rebuilt hour at or after it gives way.
    const from = ahead[0]?.at ?? Number.POSITIVE_INFINITY
    const all = [...made.filter((p) => p.at < from), ...ahead]
    if (all.length === 0) return []
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
  }, [points, shown, paceAt])

  // Waste happens at a reset: a spike there, sized by what it threw away. Before now, the resets
  // the readings show; after, the ones the chosen forecast expects.
  const past = useMemo(() => {
    if (weeklyUsed === null || weeklyResets === null) return null
    const end = Math.min(weeklyUsed.end, weeklyResets.end, gaps?.clock ?? Number.POSITIVE_INFINITY)
    return measuredResets(
      {
        stepMs: READINGS_STEP_MS,
        weeklyUsed: weeklyUsed.series,
        weeklyResetsInSeconds: weeklyResets.series,
      },
      end - HINDCAST_SPAN_MS,
      end,
    )
  }, [weeklyUsed, weeklyResets, gaps])
  const wasteSeries: ChartSeries | null = useMemo(() => {
    const times = series[0]?.points.map(([t]) => t) ?? []
    if (times.length < 2) return null
    const ahead = forecastingGaps(shown) ? shown.unusedAtReset : []
    return {
      key: 'wasted',
      label: 'Wasted at resets',
      color: 'var(--cmd-series-3)',
      points: resetSpikes([...(past ?? []), ...ahead], times),
    }
  }, [series, past, shown])
  const charts = series
    .map((s) => (s.key === 'wasted' ? wasteSeries : s))
    .filter((s): s is ChartSeries => s !== null)

  const bands = useMemo(
    () =>
      (shown?.gaps ?? []).map((g) => ({
        start: g.start,
        end: g.end ?? (shown?.clock ?? 0) + GAPS_HORIZON_MS,
      })),
    [shown],
  )
  // The week ahead as the chosen forecast sees it: each title's value.
  const ahead = useMemo(
    () => (forecastingGaps(shown) ? wasteAndClipping(shown, shown.clock, paceAt) : null),
    [shown, paceAt],
  )
  const names = shortNames((props.profiles ?? []).map((p) => p.profile))
  const clock = when === null ? null : (t: EpochMs) => when(t, now)
  // What to buy or cancel stays the headline's: it is worked out at the current pace.
  const lines = forecastingGaps(shown)
    ? [unusedLine(shown, names, clock), adviceLine(props.advice ?? null, names, now, clock)]
    : []

  return (
    <section className="cmd-forecast-history" aria-label="Waste and clipping">
      {lastWeekGaps !== null && (
        <fieldset className="cmd-segmented cmd-capacity-tabs">
          <legend className="cmd-visually-hidden">Week ahead</legend>
          <button type="button" aria-pressed={model === 'pace'} onClick={() => setModel('pace')}>
            Current pace
          </button>
          <button
            type="button"
            aria-pressed={model === 'lastWeek'}
            onClick={() => setModel('lastWeek')}
          >
            Like last week
          </button>
        </fieldset>
      )}
      {series.length === 0 || (series[0]?.points.length ?? 0) < 2 ? (
        <p className="cmd-empty">Rebuilding last week's forecasts…</p>
      ) : (
        // One chart each, on the same time axis: a week of clipping can be ten subscriptions'
        // worth, and on its scale the waste would not show.
        charts.map((s) => (
          <LineChart
            key={s.key}
            title={`${s.key === 'wasted' ? 'Wasted at resets' : 'Clipped'}${
              ahead === null
                ? ''
                : ` · ${asPercent(s.key === 'wasted' ? ahead.wasted : ahead.clipped)} ahead`
            }${
              s.key === 'wasted' && past !== null
                ? ` · ${asPercent(past.reduce((sum, r) => sum + r.unused, 0))} last week`
                : ''
            }`}
            series={[s]}
            format={asPercent}
            height={140}
            now={now}
            bands={bands}
            bandLabel="No tokens forecast"
            area
            {...(shown === null ? {} : { marker: { at: shown.clock, label: 'Now' } })}
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
        Wasted: each reset's unused share, measured before now, forecast after · clipped: before
        now, each hour's forecast of its next week; after, what is still to come · like last week:
        last week's use replayed hour by hour, short where it ran out · 100% is one subscription's
        week
      </p>
    </section>
  )
}
