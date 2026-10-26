import { useMemo, useRef, useState } from 'react'
import {
  type CapacityAdvice,
  DAY_MS,
  type EpochMs,
  GAPS_HORIZON_MS,
  HOUR_MS,
  measuredBlocked,
  measuredResets,
  type PoolGaps,
  type ProfileStatus,
  replayedPace,
  replayWeekPerWindow,
  runningBlocked,
  runningWaste,
  type Series,
  WEEK_MS,
  weekPerFiveHourWindow,
} from '../core'
import { useReadings, useWhen } from './hooks'
import { type ChartSeries, LineChart } from './LineChart'
import { adviceLine, shortNames, unusedLine } from './Pool'
import { historyQuery, READINGS_STEP_MS } from './queries'

const asPercent = (v: number) => `${Math.round(v * 100)}%`
const asHours = (v: number) => (v === 0 ? '0h' : v < 10 ? `${v.toFixed(1)}h` : `${Math.round(v)}h`)

/** Whether a forecast says anything (a reading and a login to go on). */
const forecastingGaps = (gaps: PoolGaps | null): gaps is PoolGaps =>
  gaps !== null && gaps.lasts !== 'unknown' && gaps.lasts !== 'logins'

/**
 * One of the readings last week is measured from, as last answered, with the end of the range that
 * answer covers (while a moved range loads, the last answer stays and covers less), and whether it
 * failed with none to fall back on.
 */
function useHistory(
  apiBase: string,
  now: EpochMs,
  metric: Parameters<typeof historyQuery>[1],
): { data: { series: Series[]; end: EpochMs } | null; failed: boolean } {
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
  return { data: kept.current, failed: kept.current === null && loaded.state === 'error' }
}

/**
 * Tokens wasted and time without tokens over the two weeks around now, as running totals from a
 * week ago: measured from the readings up to now, forecast after it with the last 24 hours' use or
 * last week's replayed hour by hour.
 */
export function ForecastHistory(props: {
  apiBase: string
  now: EpochMs
  /**
   * The forecast now (the headline's, at the last day's average pace): the week ahead until the
   * readings to replay are in, or when they cannot be read.
   */
  gaps: PoolGaps | null
  /** What to buy or cancel (capacityAdvice), when it has been worked out. */
  advice?: CapacityAdvice | null
  profiles: ProfileStatus[] | null
  /**
   * The headline's forecast run again at a pace that changes hour by hour (poolGaps' paceAt), for
   * the week ahead with the last day's or last week's use replayed. Without it, only the
   * headline's is shown.
   */
  forecastWith?: (paceAt: (t: EpochMs) => PoolGaps['pace']) => PoolGaps
}) {
  const { apiBase, now, gaps, forecastWith } = props
  const when = useWhen()
  const weekly = useHistory(apiBase, now, 'weeklyUsed')
  const resets = useHistory(apiBase, now, 'weeklyResetsInSeconds')
  const five = useHistory(apiBase, now, 'fiveHourUsed')
  const weeklyUsed = weekly.data
  const weeklyResets = resets.data
  const fiveUsed = five.data
  // Last week cannot be measured: the week ahead is shown alone rather than waiting for ever.
  const historyFailed = weekly.failed || resets.failed || five.failed
  const measuring = weeklyUsed !== null && weeklyResets !== null && fiveUsed !== null

  // Two forecasts of the week ahead, from the same readings once they are in: the last 24 hours
  // replayed hour by hour, every day, or last week's hours replayed once.
  const [model, setModel] = useState<'lastDay' | 'lastWeek'>('lastDay')
  const paces = useMemo(() => {
    if (weeklyUsed === null || fiveUsed === null) return null
    const end = Math.min(weeklyUsed.end, fiveUsed.end)
    const ratio = replayWeekPerWindow(
      weekPerFiveHourWindow(weeklyUsed.series, fiveUsed.series, end),
      gaps?.pace ?? null,
    )
    if (ratio === null) return null
    return {
      lastDay: replayedPace(weeklyUsed.series, ratio, weeklyUsed.end, DAY_MS),
      lastWeek: replayedPace(weeklyUsed.series, ratio, weeklyUsed.end, WEEK_MS),
    }
  }, [weeklyUsed, fiveUsed, gaps])
  const replaying = forecastWith !== undefined && paces !== null && forecastingGaps(gaps)
  const likeLastWeek = replaying && model === 'lastWeek'
  // Only the forecast shown is run: each steps through a week.
  const replayed = useMemo(
    () =>
      !replaying || forecastWith === undefined || paces === null
        ? null
        : forecastWith(likeLastWeek ? paces.lastWeek : paces.lastDay),
    [replaying, forecastWith, paces, likeLastWeek],
  )
  const shown = replayed ?? gaps

  // The two weeks around now, hour by hour, and the forecast's clock between them.
  const clock = shown?.clock ?? now
  // Exactly a week either side, so nothing at either end is rounded away; on the hour between.
  const times = useMemo(() => {
    const grid = new Set<EpochMs>([clock - WEEK_MS, clock, clock + WEEK_MS])
    const first = Math.ceil((clock - WEEK_MS) / HOUR_MS) * HOUR_MS
    for (let t = first; t < clock + WEEK_MS; t += HOUR_MS) grid.add(t)
    return [...grid].sort((a, b) => a - b)
  }, [clock])

  // Before now, what the readings show; after it, what the chosen forecast expects.
  const past = useMemo(() => {
    if (weeklyUsed === null || weeklyResets === null || fiveUsed === null) return null
    const from = times[0] ?? clock
    // Up to the forecast's clock, where the forecast takes over: the last readings stand until
    // then (measuredBlocked), so no minutes fall between the two.
    const end = clock
    const history = {
      stepMs: READINGS_STEP_MS,
      weeklyUsed: weeklyUsed.series,
      weeklyResetsInSeconds: weeklyResets.series,
      fiveHourUsed: fiveUsed.series,
    }
    return {
      resets: measuredResets(history, from, end),
      blocked: measuredBlocked(history, from, end),
    }
  }, [weeklyUsed, weeklyResets, fiveUsed, times, clock])
  const ahead = useMemo(() => {
    if (!forecastingGaps(shown)) return null
    const until = shown.clock + GAPS_HORIZON_MS
    return {
      resets: shown.unusedAtReset.filter((r) => r.at >= shown.clock),
      blocked: shown.gaps.map((g) => ({
        start: Math.max(g.start, shown.clock),
        end: Math.min(g.end ?? until, until),
      })),
    }
  }, [shown])

  const series: ChartSeries[] = useMemo(() => {
    const resetsSeen = [...(past?.resets ?? []), ...(ahead?.resets ?? [])]
    const blocked = [...(past?.blocked ?? []), ...(ahead?.blocked ?? [])]
    return [
      {
        key: 'wasted',
        label: 'Wasted at resets',
        color: 'var(--cmd-series-3)',
        points: runningWaste(resetsSeen, times),
      },
      {
        key: 'blocked',
        label: 'Without tokens',
        color: 'var(--cmd-series-2)',
        points: runningBlocked(blocked, times),
      },
    ]
  }, [past, ahead, times])

  // Each title: last week's total and this week's (the next seven days).
  const totalAt = (s: ChartSeries, t: EpochMs) =>
    s.points.filter(([time]) => time <= t).at(-1)?.[1] ?? 0
  const bands = useMemo(
    () => [...(past?.blocked ?? []), ...(ahead?.blocked ?? [])].filter((b) => b.end > b.start),
    [past, ahead],
  )

  const names = shortNames((props.profiles ?? []).map((p) => p.profile))
  const clockText = when === null ? null : (t: EpochMs) => when(t, now)
  // What to buy or cancel stays the headline's: it is worked out at the current pace.
  const lines = forecastingGaps(shown)
    ? [unusedLine(shown, names, clockText), adviceLine(props.advice ?? null, names, now, clockText)]
    : []

  return (
    <section className="cmd-forecast-history" aria-label="Waste and time without tokens">
      {forecastingGaps(gaps) && (
        <fieldset className="cmd-segmented cmd-capacity-tabs">
          <legend className="cmd-visually-hidden">Week ahead</legend>
          {/* Pressed is the forecast shown: last week's falls back to the last day's when it goes. */}
          <button type="button" aria-pressed={!likeLastWeek} onClick={() => setModel('lastDay')}>
            Like last 24 hours
          </button>
          <button
            type="button"
            aria-pressed={likeLastWeek}
            disabled={!replaying}
            title={replaying ? undefined : "Waiting for last week's readings"}
            onClick={() => setModel('lastWeek')}
          >
            Like last week
          </button>
        </fieldset>
      )}
      {!measuring && !historyFailed ? (
        // The totals run from a week ago: until last week is read, they would start from nothing.
        <p className="cmd-empty cmd-forecast-loading">Reading last week…</p>
      ) : (
        series.map((s) => {
          const format = s.key === 'wasted' ? asPercent : asHours
          const sofar = totalAt(s, clock)
          const lastWeek = past === null ? '' : ` · ${format(sofar)} last week`
          const nextWeek =
            ahead === null ? '' : ` · ${format((s.points.at(-1)?.[1] ?? 0) - sofar)} this week`
          return (
            <LineChart
              key={s.key}
              title={`${s.label}${lastWeek}${nextWeek}`}
              series={[s]}
              format={format}
              height={140}
              now={now}
              // The time without tokens is shaded on its own chart only: on the waste chart it
              // would read as waste.
              bands={s.key === 'blocked' ? bands : []}
              bandLabel="Without tokens"
              area
              marker={{ at: clock, label: 'Now' }}
            />
          )
        })
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
        Running totals from a week ago: measured before now, forecast after (this week: the next
        seven days) · wasted: what each weekly reset threw away, 100% being one subscription's week
        · without tokens: hours no subscription could take work · ahead: the last 24 hours' use, or
        last week's, replayed hour by hour
      </p>
    </section>
  )
}
