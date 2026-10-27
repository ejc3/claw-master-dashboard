'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AlarmStatus,
  burnRate,
  type CapacityAdvice,
  capacityAdvice,
  type EpochMs,
  forecastProfiles,
  formatCount,
  formatCountdown,
  formatPercent,
  fromFirstBucket,
  HOUR_MS,
  hasHeadroom,
  type PoolGaps,
  type ProfileStatus,
  poolGaps,
  poolPace,
  poolRates,
  type Series,
  type SeriesQuery,
  type Snapshot,
  subscriptionCount,
  sumBetween,
  sumSeries,
  TOKEN_CHOICES,
  TOKEN_LABELS,
  TOKEN_TYPES,
  type TokenChoice,
  tokenChoiceLabel,
  tokenCoverage,
  tokensBetween,
  tokensOfType,
  WEEKLY_SMOOTHING_MS,
} from '../core'
import { useSharedAnswers } from './answers'
import { Breakdown } from './Breakdown'
import { ForecastHistory } from './ForecastHistory'
import {
  type FirstPaint,
  FirstPaintContext,
  type Loaded,
  SERIES_POLL_MS,
  useAlarms,
  useCountedSeries,
  useLastReady,
  useNow,
  usePrefetch,
  useReadings,
  useReportTimeZone,
  useSeries,
  useSnapshot,
} from './hooks'
import { type ChartSeries, foldSeries, LineChart, seriesColors } from './LineChart'
import { accountColors, PoolOutlook } from './Pool'
import type { PollFailure } from './poller'
import { createPollStore, PollStoreContext } from './pollStore'
import {
  backupOutputQuery,
  chartQuery,
  FIRST_RANGE,
  type FirstSeries,
  kpiHourEnd,
  kpiQuery,
  kpiTokensQuery,
  projectsQuery,
  queryKey,
  RANGES,
  type RangeName,
  readingsQuery,
  tabQueries,
  tokensByProfileQuery,
} from './queries'
import { RunwayCard } from './Runway'

export interface DashboardProps {
  /** The snapshot rendered on the server, or null when the source did not answer then. */
  initialSnapshot: Snapshot | null
  /** claude-master's alarms as the server read them, or null when it could not. */
  initialAlarms?: AlarmStatus[] | null
  /** Where the dashboard's route handler is mounted, e.g. "/api/claude-master". */
  apiBase: string
  /** Where a viewer whose session ended signs in again; omitted, no link is shown. */
  signInHref?: string
  title?: string
  /** True when the source is the demo fixture: a label says so, so made-up numbers never pass for real ones. */
  demoData?: boolean
  /**
   * When the server rendered the page. The first render in the browser uses this clock, so it
   * asks for the same ranges and shows the same countdowns as the server's.
   */
  renderedAt?: EpochMs
  /** The server's answers to the first queries (firstQueries), by queryKey. */
  firstSeries?: FirstSeries
  /** The viewer's time zone as the browser last reported it, or null when not yet known. */
  timeZone?: string | null
}

/** Sums points into whole hours. */
function hourly(points: Array<[EpochMs, number]>): Array<[EpochMs, number]> {
  const out = new Map<EpochMs, number>()
  for (const [t, v] of points) {
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS
    out.set(hour, (out.get(hour) ?? 0) + v)
  }
  return [...out.entries()]
}

const data = <T,>(loaded: Loaded<T>): T | null => (loaded.state === 'ready' ? loaded.data : null)

/**
 * The time the forecast is worked out for: the start of the current minute, or a reset or rate
 * limit that ended since then, whichever is later. It changes once a minute and at each such end.
 */
export function forecastClock(profiles: readonly ProfileStatus[] | null, now: EpochMs): EpochMs {
  let at = Math.floor(now / 60_000) * 60_000
  for (const p of profiles ?? []) {
    for (const t of [p.weekly.resetsAt, p.fiveHour?.resetsAt ?? null, p.rateLimitedUntil]) {
      if (t !== null && t > at && t <= now) at = t
    }
  }
  return at
}
const failureOf = <T,>(loaded: Loaded<T>): PollFailure | null =>
  loaded.state === 'error' ? loaded.failure : loaded.state === 'ready' ? loaded.failure : null

function Kpi(props: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="cmd-kpi">
      <p className="cmd-kpi-label">{props.label}</p>
      <p className="cmd-kpi-value">{props.value}</p>
      {props.note !== undefined && <p className="cmd-kpi-note">{props.note}</p>}
    </div>
  )
}

export function Dashboard(props: DashboardProps) {
  const { firstSeries = {}, timeZone = null } = props
  const firstPaint = useMemo<FirstPaint>(
    () => ({ series: firstSeries, timeZone }),
    [firstSeries, timeZone],
  )
  // One poller per URL for the whole page, so a tab loaded in the background shows at once.
  const [pollStore] = useState(createPollStore)
  return (
    <FirstPaintContext.Provider value={firstPaint}>
      <PollStoreContext.Provider value={pollStore}>
        <DashboardBody {...props} />
      </PollStoreContext.Provider>
    </FirstPaintContext.Provider>
  )
}

function DashboardBody(props: DashboardProps) {
  const { initialSnapshot, apiBase, signInHref, title = 'claw-master', demoData = false } = props
  useReportTimeZone()
  const now = useNow(1000, props.renderedAt ?? initialSnapshot?.asOf ?? 0)
  const snapshotLoaded = useSnapshot(apiBase, initialSnapshot)
  const snapshot = data(snapshotLoaded) ?? initialSnapshot
  const [rangeName, setRangeName] = useState<RangeName>(FIRST_RANGE)
  const [tokenChoice, setTokenChoice] = useState<TokenChoice>('all')
  const chosen = RANGES[rangeName]

  // The request URLs change once per step, not every second (useSeries keys on the URL).
  const inRange = (q: Omit<SeriesQuery, 'range' | 'stepSeconds'>): SeriesQuery =>
    chartQuery(now, rangeName, q)
  const range = inRange({ metric: 'requests' }).range
  const byProfile = useSeries(apiBase, inRange({ metric: 'requests', groupBy: 'profile' }))
  // Tokens are what matters; requests are the fallback for a range with no token counts yet
  // (before the release that counts them).
  // Every token choice in one answer, by subscription and type.
  const tokensByProfile = useCountedSeries(apiBase, tokensByProfileQuery(now, rangeName))
  const tokenRangeCoverage =
    tokensByProfile.loaded.state === 'ready'
      ? tokenCoverage(tokensByProfile.firstAt, range, chosen.stepSeconds)
      : null
  const errors = useSeries(apiBase, inRange({ metric: 'errors' }))
  // Every other tab (range, token choice, breakdown split) loads in the background once what is
  // on screen has, and stays fresh on the same five minutes.
  const shownLoaded = [byProfile, tokensByProfile.loaded, errors].every(
    (l) => l.state !== 'loading',
  )
  // The URLs move once per step of each range, not every second.
  const rangeEnds = (Object.keys(RANGES) as RangeName[])
    .map((name) => chartQuery(now, name, { metric: 'requests' }).range.end)
    .join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ranges' ends, not on now
  const tabUrls = useMemo(
    () => tabQueries(now, rangeName).map((q) => `${apiBase}/series?${queryKey(q)}`),
    [apiBase, rangeName, rangeEnds],
  )
  usePrefetch(tabUrls, SERIES_POLL_MS, shownLoaded)
  // Each subscription's weekly readings over the range, as returned (not zero-filled): how many
  // subscriptions the pool had, so a step up in capacity shows when one was added.
  const subsQuery = inRange({ metric: 'weeklyUsed', groupBy: 'profile' })
  const subsData = data(useReadings(apiBase, subsQuery))
  const { start: subsStart, end: subsEnd } = subsQuery.range
  const subsLine: ChartSeries[] = useMemo(
    () =>
      subsData === null
        ? []
        : [
            {
              key: 'subscriptions',
              label: 'Subscriptions',
              color: 'var(--cmd-series-1)',
              points: subscriptionCount(subsData, {
                range: { start: subsStart, end: subsEnd },
                stepSeconds: chosen.stepSeconds,
              }),
            },
          ],
    [subsData, subsStart, subsEnd, chosen.stepSeconds],
  )
  // The paid backup's key number is always the last day's: its controls are further down.
  const backup = useSeries(apiBase, chartQuery(now, '24h', { metric: 'backupRequests' }))
  // What the paid API's work cost: its output tokens, the subscription named api-backup.
  const backupOutput = useSeries(apiBase, backupOutputQuery(now))
  // Projects that used tokens in the last day ("none" is work no launch named a project for).
  const projectsLoaded = useSeries(apiBase, projectsQuery(now))
  const projectsData = data(projectsLoaded)
  const projectTotals = tokensOfType(projectsData ?? [], 'all')
    .filter((s) => s.key !== 'none')
    .map((s) => ({ key: s.key, total: s.points.reduce((sum, [, v]) => sum + v, 0) }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total)
  const projectsAll = projectTotals.reduce((sum, p) => sum + p.total, 0)
  const topProject = projectTotals[0]

  // Key numbers have their own five-minute queries, whatever the range (kpiRange).
  const kpiRequests = useSeries(apiBase, kpiQuery(now, 'requests'))
  const kpiErrors = useSeries(apiBase, kpiQuery(now, 'errors'))
  const kpiTokens = useCountedSeries(apiBase, kpiTokensQuery(now))
  // Each answer's hours come from the range it answers: while a moved range loads, the last
  // answer stays on show, and its last full hour ends where it did when it arrived.
  const hourEndOf = (loaded: Loaded<unknown>) =>
    loaded.state === 'ready' && loaded.range !== undefined ? kpiHourEnd(loaded.range) : null
  const requestsEnd = hourEndOf(kpiRequests)
  const tokensEnd = hourEndOf(kpiTokens.loaded)
  const kpiTokensData = data(kpiTokens.loaded)
  const tokensLastHour =
    kpiTokensData === null || kpiTokens.firstAt === null || tokensEnd === null
      ? null
      : tokensBetween(kpiTokensData, tokensEnd - HOUR_MS, tokensEnd)
  const tokensLastHourTotal =
    tokensLastHour === null ? null : TOKEN_TYPES.reduce((sum, t) => sum + tokensLastHour[t], 0)
  const total = (series: Series[] | null) => (series === null ? null : sumSeries(series))
  const kpiRequestsTotal = total(data(kpiRequests))
  const lastHour = (points: Array<[EpochMs, number]> | null, end: EpochMs | null, back = 0) =>
    points === null || end === null
      ? null
      : sumBetween(points, end - (back + 1) * HOUR_MS, end - back * HOUR_MS)
  const requestsLastHour = lastHour(kpiRequestsTotal, requestsEnd)
  const requestsHourBefore = lastHour(kpiRequestsTotal, requestsEnd, 1)
  // The error rate needs one hour both answers cover.
  const kpiRate = useSharedAnswers({ requests: kpiRequests, errors: kpiErrors })
  const rateEnd = kpiRate === null ? null : kpiHourEnd(kpiRate.range)
  const errorsLastHour = lastHour(total(kpiRate?.data.errors ?? null), rateEnd)
  const requestsForRate = lastHour(total(kpiRate?.data.requests ?? null), rateEnd)

  const byProfileData = data(byProfile)
  const tokensByProfileTypes = data(tokensByProfile.loaded)
  const tokensByProfileData = useMemo(
    () => (tokensByProfileTypes === null ? null : tokensOfType(tokensByProfileTypes, tokenChoice)),
    [tokensByProfileTypes, tokenChoice],
  )
  const showTokens = tokenRangeCoverage !== null && tokenRangeCoverage !== 'none'
  const chartData = showTokens
    ? fromFirstBucket(tokensByProfileData ?? [], tokensByProfile.firstAt, chosen.stepSeconds)
    : byProfileData
  const knownKey = (snapshot?.profiles ?? []).map((p) => p.profile).join('\n')
  const knownProfiles = useMemo(() => knownKey.split('\n').filter((n) => n !== ''), [knownKey])
  // One color per subscription for every chart, bar and row.
  const subscriptionColors = useMemo(() => accountColors(knownProfiles), [knownProfiles])

  const profileLines: ChartSeries[] = useMemo(() => {
    if (chartData === null) return []
    const folded = foldSeries(chartData)
    // Colors come from the known subscriptions alone (accountColors' rule), so a subscription has
    // the same color here as everywhere else on the page.
    const colors = seriesColors(
      knownProfiles,
      folded.map((s) => s.key),
    )
    return folded.map((s) => ({
      ...s,
      label: s.key,
      color: colors.get(s.key) ?? 'var(--cmd-ink-3)',
    }))
  }, [chartData, knownProfiles])

  // Per hour, not per step: a few requests at night make a five-minute error rate swing wildly.
  // Unknown when either side is unknown: a failed errors query is not a 0% error rate. Only the
  // hours both answers cover.
  const rateAnswers = useSharedAnswers({ requests: byProfile, errors })
  const errorRate: ChartSeries[] = useMemo(() => {
    if (rateAnswers === null) return []
    const requestsHourly = hourly(sumSeries(rateAnswers.data.requests))
    const errorsHourly = new Map(hourly(sumSeries(rateAnswers.data.errors)))
    const points = requestsHourly.map(([t, r]): [EpochMs, number] => [
      t,
      r === 0 ? 0 : (errorsHourly.get(t) ?? 0) / r,
    ])
    return [{ key: 'error-rate', label: 'Error rate', color: 'var(--cmd-series-1)', points }]
  }, [rateAnswers])

  // The pace is the pool's: its weekly use over the last day of readings, and the 5-hour pace that
  // same work makes, at what a full 5-hour window costs of the week (poolRates, poolPace). Where the
  // readings cannot tell, each subscription's smoothed weekly rate and each 5-hour window's average
  // so far, as poolGaps measures them.
  const usedQuery = readingsQuery(now)
  const smoothingRange = usedQuery.range
  const usedReadings = useReadings(apiBase, usedQuery)
  // The last readings stay in use while the next range loads: the range moves every 10 minutes.
  const usedData = useLastReady(usedReadings)
  const smoothed = useMemo(() => {
    const rates = new Map<string, number | null>()
    for (const s of usedData ?? []) {
      rates.set(s.key, burnRate(s.points, smoothingRange.end, WEEKLY_SMOOTHING_MS))
    }
    return rates
  }, [usedData, smoothingRange.end])
  const fiveData = useLastReady(useReadings(apiBase, readingsQuery(now, 'fiveHourUsed')))
  const rates = useMemo(
    () => poolRates(usedData ?? [], fiveData ?? [], smoothingRange.end),
    [usedData, fiveData, smoothingRange.end],
  )
  const profilesNow = snapshot?.profiles ?? null
  // When no subscription can take work, from both windows at once: the headline.
  // Once a minute, not every second: the simulation steps through a week. Also the moment a
  // reset or a rate limit ends, so the headline turns the second quota comes back instead of
  // saying "back in now" until the minute is up.
  const gapsAt = forecastClock(profilesNow, now)
  const asOf = snapshot?.asOf ?? gapsAt
  // As the forecast should see them: the poll's 100% leaves a little while Anthropic still takes
  // the subscription's work (forecastProfiles), so the headline says it runs out shortly, not that
  // it is out; a refusal holds one until it ends.
  const forecastable = useMemo(
    () => (profilesNow === null ? null : forecastProfiles(profilesNow, gapsAt)),
    [profilesNow, gapsAt],
  )
  // From the later of the readings and the clock: Anthropic has not refused what it has taken since
  // the readings, so the last percent a full window keeps counts from now, not spent already.
  const forecastFrom = Math.max(asOf, gapsAt)
  // The pace, though, is measured at the readings: a 5-hour window that has reset since has no
  // pace of its own left to measure from now.
  const pace = useMemo(
    () =>
      forecastable === null
        ? null
        : poolPace(poolGaps(forecastable, asOf, smoothed, gapsAt).pace, rates),
    [forecastable, asOf, smoothed, gapsAt, rates],
  )
  const gaps = useMemo(
    () =>
      forecastable === null || pace === null
        ? null
        : poolGaps(forecastable, forecastFrom, smoothed, gapsAt, false, pace),
    [forecastable, forecastFrom, smoothed, gapsAt, pace],
  )
  // The same forecast at a pace that changes hour by hour (the waste section's like last week).
  const forecastWith = useCallback(
    (paceAt: (t: EpochMs) => PoolGaps['pace']) =>
      poolGaps(
        forecastable ?? [],
        forecastFrom,
        smoothed,
        gapsAt,
        false,
        pace ?? undefined,
        paceAt,
      ),
    [forecastable, forecastFrom, smoothed, gapsAt, pace],
  )
  // The same with no more use: what is left only comes back as limits reset.
  const gapsIfStopped = useMemo(
    () =>
      forecastable === null ? null : poolGaps(forecastable, forecastFrom, smoothed, gapsAt, true),
    [forecastable, forecastFrom, smoothed, gapsAt],
  )
  // What to buy or cancel: a few dozen runs of the same forecast, so worked out after the page is
  // up and again only when a new snapshot or pace arrives, never on the clock's tick.
  const [advice, setAdvice] = useState<CapacityAdvice | null>(null)
  // The clock when it is worked out, not the snapshot's time: a late snapshot must not advise
  // buying for a cooldown that has already ended. Read through a ref, so the tick does not rerun it.
  const clock = useRef(now)
  clock.current = now
  useEffect(() => {
    if (profilesNow === null) return
    const timer = setTimeout(() => {
      const at = Math.max(asOf, clock.current)
      const profiles = forecastProfiles(profilesNow, at)
      // The pace at the readings, the forecast from the clock (as the headline's).
      const measured = poolPace(poolGaps(profiles, asOf, smoothed, at).pace, rates)
      setAdvice(capacityAdvice(profiles, at, smoothed, at, measured))
    }, 0)
    return () => clearTimeout(timer)
  }, [profilesNow, asOf, smoothed, rates])
  const ready = (profilesNow ?? []).filter((p) => hasHeadroom(p, now)).length
  const outlookDetail =
    profilesNow === null
      ? 'No data yet · retrying every minute'
      : profilesNow.length === 0
        ? 'No subscriptions reporting yet'
        : `${ready} of ${profilesNow.length} available now`

  const failures = [
    failureOf(snapshotLoaded),
    failureOf(byProfile),
    failureOf(errors),
    failureOf(backup),
    failureOf(kpiRequests),
    failureOf(kpiErrors),
    failureOf(tokensByProfile.loaded),
    failureOf(kpiTokens.loaded),
    failureOf(usedReadings),
  ].filter((f): f is PollFailure => f !== null)
  const signedOut = failures.some((f) => f.status === 401)
  const snapshotFailure = failureOf(snapshotLoaded)

  const ageMs = snapshot === null ? null : now - snapshot.asOf
  const stale = ageMs !== null && ageMs > 10 * 60_000
  const freshness =
    ageMs === null
      ? 'No reading yet'
      : stale
        ? `No reading for ${formatCountdown(ageMs)}`
        : ageMs < 60_000
          ? 'Updated just now'
          : `Updated ${formatCountdown(ageMs)} ago`
  const backupTotal = data(backup)
  // claude-master's alarms: open now, and cleared in the last day.
  const alarmsLoaded = useAlarms(apiBase, props.initialAlarms ?? null)
  const alarms = data(alarmsLoaded)
  const alarmName = (name: string) => name.replace(/^claude-master-/, '').replaceAll('-', ' ')
  const openAlarms = (alarms ?? []).filter((a) => a.state === 'ALARM')
  const clearedAlarms = (alarms ?? []).filter(
    (a) => a.state === 'OK' && a.since >= now - 24 * HOUR_MS && a.since <= now,
  )
  const alarmsFailure = failureOf(alarmsLoaded)
  const backupOutputData = data(backupOutput)
  const backupOutputTokens =
    backupOutputData === null
      ? null
      : (
          tokensOfType(backupOutputData, 'output').find((s) => s.key === 'api-backup')?.points ?? []
        ).reduce((sum, [, v]) => sum + v, 0)
  const rangeWords = rangeName === '24h' ? 'last 24 hours' : 'last 7 days'

  const tokenControl = (
    <fieldset className="cmd-segmented">
      <legend className="cmd-visually-hidden">Token type for the chart and table</legend>
      {TOKEN_CHOICES.map((choice) => (
        <button
          type="button"
          key={choice}
          aria-pressed={choice === tokenChoice}
          onClick={() => setTokenChoice(choice)}
        >
          {choice === 'all' ? 'All' : TOKEN_LABELS[choice]}
        </button>
      ))}
    </fieldset>
  )
  const chartNote =
    tokenRangeCoverage === 'none' ? 'No token counts for this range yet; showing requests.' : null
  const chartTitle = showTokens
    ? `${tokenChoice === 'all' ? 'Tokens' : `${tokenChoiceLabel(tokenChoice)} tokens`} ${chosen.per}, by subscription`
    : `Requests ${chosen.per}, by subscription`

  const rangeControl = (
    <fieldset className="cmd-segmented">
      <legend className="cmd-visually-hidden">Time range for the charts and table</legend>
      {(Object.keys(RANGES) as RangeName[]).map((name) => (
        <button
          type="button"
          key={name}
          aria-pressed={name === rangeName}
          onClick={() => setRangeName(name)}
        >
          {RANGES[name].label}
        </button>
      ))}
    </fieldset>
  )

  return (
    <div className="cmd-root">
      <div className="cmd-frame">
        <header className="cmd-header">
          <div className="cmd-header-text">
            <h1 className="cmd-title">
              {title}
              {demoData && (
                <span className="cmd-demo" role="status" title="A fixture, not CloudWatch">
                  Demo data
                </span>
              )}
            </h1>
            <span className="cmd-freshness" data-stale={stale || snapshotFailure !== null}>
              <span className="cmd-pulse" aria-hidden="true" />
              {freshness}
              {snapshotFailure !== null && !signedOut ? '; the last refresh failed' : ''}
            </span>
          </div>
        </header>

        {signedOut && (
          <p className="cmd-banner" role="alert">
            Your session has ended.{' '}
            {signInHref !== undefined && <a href={signInHref}>Sign in again</a>}
          </p>
        )}

        <PoolOutlook
          gaps={gaps}
          gapsIfStopped={gapsIfStopped}
          profiles={profilesNow}
          now={now}
          detail={outlookDetail}
        />

        <ForecastHistory
          apiBase={apiBase}
          now={now}
          gaps={gaps}
          advice={advice}
          profiles={profilesNow}
          forecastWith={forecastWith}
        />

        <section className="cmd-kpis" aria-label="Traffic">
          {tokensLastHour === null || tokensLastHourTotal === null ? (
            <Kpi
              label="Requests, last hour"
              value={formatCount(requestsLastHour)}
              note={
                kpiTokens.loaded.state === 'ready'
                  ? 'No token counts yet'
                  : requestsHourBefore === null
                    ? undefined
                    : `${formatCount(requestsHourBefore)} the hour before`
              }
            />
          ) : (
            <Kpi
              label="Tokens, last hour"
              value={formatCount(tokensLastHourTotal)}
              note={TOKEN_TYPES.map(
                (t) => `${formatCount(tokensLastHour[t])} ${TOKEN_LABELS[t].toLowerCase()}`,
              ).join(' · ')}
            />
          )}
          <Kpi
            label="Error rate, last hour"
            value={formatPercent(
              requestsForRate === null || errorsLastHour === null || requestsForRate === 0
                ? null
                : errorsLastHour / requestsForRate,
            )}
            note={
              errorsLastHour === null
                ? failureOf(kpiErrors) === null
                  ? undefined
                  : 'Error counts are unavailable'
                : `${formatCount(errorsLastHour)} errors from Anthropic`
            }
          />
          <Kpi
            label="Active projects, last 24 hours"
            value={
              projectsData === null || projectTotals.length === 0
                ? '—'
                : formatCount(projectTotals.length)
            }
            note={
              topProject === undefined
                ? projectsData === null
                  ? undefined
                  : 'None reported yet'
                : `Most: ${topProject.key}, ${formatPercent(topProject.total / projectsAll)}`
            }
          />
          <Kpi
            label="Alarms"
            value={
              alarms === null
                ? '—'
                : openAlarms.length === 0
                  ? 'None open'
                  : `${openAlarms.length} open`
            }
            note={
              alarms === null
                ? alarmsFailure === null
                  ? undefined
                  : alarmsFailure.status === 403
                    ? "Can't read alarms yet"
                    : 'Alarms unavailable'
                : [
                    ...openAlarms.map((a) => alarmName(a.name)),
                    ...(clearedAlarms.length === 0
                      ? []
                      : [`${clearedAlarms.length} cleared in 24h`]),
                  ].join(' · ') || undefined
            }
          />
          <Kpi
            label="Paid API output tokens, last 24 hours"
            value={formatCount(backupOutputTokens)}
            note={
              backupTotal === null
                ? undefined
                : `${formatCount(sumBetween(sumSeries(backupTotal), 0, Infinity))} requests`
            }
          />
        </section>

        {/* Above what they change: the charts and the table below. */}
        <div className="cmd-controls cmd-toolbar">
          {tokenControl}
          {rangeControl}
        </div>

        {/* Who and what used the tokens first, then the pool's subscriptions over time. */}
        <Breakdown
          apiBase={apiBase}
          range={range}
          stepSeconds={chosen.stepSeconds}
          rangeWords={rangeWords}
          per={chosen.per}
          tokenChoice={tokenChoice}
          now={now}
          colors={subscriptionColors}
        />

        <div className="cmd-charts">
          <div>
            {(showTokens ? tokensByProfile.loaded : byProfile).state === 'error' && (
              <p className="cmd-error">
                {
                  (failureOf(showTokens ? tokensByProfile.loaded : byProfile) as PollFailure)
                    .message
                }
              </p>
            )}
            {(tokensByProfile.loaded.state === 'loading' ||
              (!showTokens && byProfile.state === 'loading')) && (
              <p className="cmd-empty">Loading…</p>
            )}
            {chartNote !== null && <p className="cmd-note">{chartNote}</p>}
            {profileLines.length > 0 && (
              <LineChart
                title={chartTitle}
                series={profileLines}
                format={formatCount}
                integer
                now={now}
              />
            )}
          </div>
          <div>
            {errors.state === 'error' && <p className="cmd-error">{errors.failure.message}</p>}
            {errorRate.length > 0 && (
              <LineChart
                title="Error rate per hour"
                series={errorRate}
                format={(v) => formatPercent(v)}
                now={now}
                area
              />
            )}
          </div>
          {subsLine.length > 0 && (
            <div className="cmd-charts-wide">
              <LineChart
                title={`Subscriptions in the pool · ${subsLine[0]?.points.at(-1)?.[1] ?? 0} now`}
                series={subsLine}
                format={(v) => String(Math.round(v))}
                integer
                height={120}
                now={now}
              />
            </div>
          )}
        </div>

        {/* Each subscription in detail, below the traffic: the outlook above already sums them up. */}
        <section className="cmd-panel cmd-stream" aria-labelledby="cmd-subscriptions">
          <div className="cmd-panel-header cmd-stream-columns">
            <h2 className="cmd-panel-label" id="cmd-subscriptions">
              Subscriptions
            </h2>
            <span className="cmd-panel-label cmd-wide-only" aria-hidden="true">
              Weekly allowance
            </span>
            <span className="cmd-panel-label cmd-wide-only" aria-hidden="true">
              5-hour window
            </span>
          </div>
          {(snapshot?.profiles ?? []).map((p) => (
            <RunwayCard
              key={p.profile}
              status={p}
              now={now}
              color={subscriptionColors.get(p.profile)}
            />
          ))}
        </section>
      </div>
    </div>
  )
}
