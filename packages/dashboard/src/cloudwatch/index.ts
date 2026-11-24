import 'server-only'

import { AwsClient } from 'aws4fetch'
import { insightsQuery, resolveMetric } from '../core/catalog'
import { inTurn } from '../core/limit'
import { validateSeriesQuery } from '../core/query'
import {
  type AlarmStatus,
  type Band,
  type BankedResets,
  type EpochMs,
  type FableAllowance,
  FIVE_HOURS_MS,
  type LatencyQuantiles,
  type MetricsSource,
  type ProfileStatus,
  type QuotaWindow,
  type Series,
  type SeriesQuery,
  type Snapshot,
  TOKEN_TYPES,
  WEEK_MS,
} from '../core/types'

/**
 * The CloudWatch source: reads the `ClawMaster` namespace with GetMetricData (Metrics Insights)
 * over CloudWatch's JSON protocol, signed with SigV4 by aws4fetch, so it runs on Workers as well as
 * Node. Each Metrics Insights query is its own call (the API allows one per GetMetricData), cached
 * and coalesced for about a minute, the export interval, so a page load with many viewers reads
 * each query once.
 */
export interface CloudWatchSourceOptions {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
  /** The namespace claude-master's metrics land in. */
  namespace?: string
  /** How long a query's answer is reused, in ms. */
  cacheMs?: number
  /** The clock; tests pass a fixed one. */
  now?: () => EpochMs
  /** The fetch used after signing; tests pass a fake. */
  fetch?: typeof fetch
  /** Overrides the regional endpoint. */
  endpoint?: string
  /**
   * Account codes to people's names (`acct-<hash>` -> name). Points exported before the server
   * labelled accounts carry the code; a person's series under both is shown once, under the name.
   * A function is asked on every split by person, so aliases can change without a restart; if it
   * fails, the series are shown unfolded.
   */
  accountAliases?: ReadonlyMap<string, string> | (() => Promise<ReadonlyMap<string, string>>)
  /**
   * How long to wait before each retry of a throttled call, in ms (each wait gets up to as much
   * again at random, so a page's queries do not retry in step). Empty: no retries.
   */
  throttleRetriesMs?: readonly number[]
  /** Waits `ms`; tests pass one that does not. */
  sleep?: (ms: number) => Promise<void>
}

/** CloudWatch refused or failed a request; `code` is its error type, the message its text. */
/** The alarms the dashboard shows: claude-master's, all named with this prefix. */
export const ALARM_PREFIX = 'claude-master'

interface WireAlarm {
  AlarmName?: unknown
  StateValue?: unknown
  /** Epoch seconds in CloudWatch's JSON protocol. */
  StateUpdatedTimestamp?: unknown
}

interface WireAlarms {
  MetricAlarms?: WireAlarm[]
  CompositeAlarms?: WireAlarm[]
  NextToken?: string
}

export class CloudWatchError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(`CloudWatch answered ${status} ${code}: ${message}`)
    this.name = 'CloudWatchError'
    this.status = status
    this.code = code
  }
}

const ALIAS_LINE = /^(acct-[0-9a-f]+)\s*=\s*(\S(?:.*\S)?)$/

/** The DASHBOARD_CONFIG KV key the account aliases are read from (the allowlist's namespace). */
export const ACCOUNT_ALIASES_KEY = 'account-aliases'

/**
 * Reads account aliases: one `acct-<hash>=NAME` line per person. Blank lines and `#` comments are
 * skipped; a malformed line is ignored, and how many were is logged, never which. `from` names
 * where the text came from in that message.
 */
export function parseAccountAliases(
  text: string | undefined,
  warn: (message: string) => void = console.warn,
  from = 'the account aliases',
): Map<string, string> {
  const aliases = new Map<string, string>()
  if (text === undefined) return aliases
  let malformed = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = ALIAS_LINE.exec(line)
    if (match === null || (match[2] as string).length > 64) {
      malformed++
      continue
    }
    aliases.set(match[1] as string, match[2] as string)
  }
  if (malformed > 0) {
    warn(
      `claw-master dashboard: ${malformed} malformed line${malformed === 1 ? '' : 's'} in ${from} ignored`,
    )
  }
  return aliases
}

/**
 * Renames each series by the aliases and merges the ones that land on the same name: summed at
 * a shared timestamp for a SUM metric, the larger value otherwise. A key not in the map stays.
 */
export function foldAliases(
  series: Series[],
  aliases: ReadonlyMap<string, string>,
  statistic: string,
): Series[] {
  if (aliases.size === 0) return series
  const merged = new Map<string, Map<EpochMs, number>>()
  for (const s of series) {
    const key = aliases.get(s.key) ?? s.key
    const points = merged.get(key) ?? new Map<EpochMs, number>()
    for (const [at, value] of s.points) {
      const prior = points.get(at)
      points.set(
        at,
        prior === undefined ? value : statistic === 'SUM' ? prior + value : Math.max(prior, value),
      )
    }
    merged.set(key, points)
  }
  return [...merged.entries()].map(([key, points]) => ({
    key,
    points: [...points.entries()].sort((a, b) => a[0] - b[0]),
  }))
}

export const DEFAULT_NAMESPACE = 'ClawMaster'
export const DEFAULT_CACHE_MS = 60_000
/** How far back the snapshot looks for each gauge's latest reading. */
export const SNAPSHOT_LOOKBACK_MS = 15 * 60_000

/**
 * How far back the 5-hour window's reading is looked for. It comes from Anthropic's response
 * headers, so it stops when a subscription stops serving, as one whose 5-hour window is full
 * does; the last reading holds until its window resets, at most five hours on.
 */
export const FIVE_HOUR_LOOKBACK_MS = FIVE_HOURS_MS

/**
 * How far back the usage poll's word on whether a plan has a 5-hour limit is looked for, hour by
 * hour: it holds until a later poll says otherwise, through restarts and failed polls.
 */
export const FIVE_HOUR_LIMIT_LOOKBACK_MS = 7 * 24 * 3_600_000

/** Whether a plan has a 5-hour limit, from the latest hour of the poll's gauge; null with none. */
export function fiveHourLimitFrom(reading: [EpochMs, number] | null): boolean | null {
  return reading === null ? null : reading[1] >= 0.5
}

/**
 * The weekly Fable allowance from its three gauges, each the latest [time, value]; null when the
 * subscription reports neither a Fable figure nor a refusal. A countdown is turned into a time from
 * when it was read; one of zero or less means no reset is known, or no refusal is in force. A
 * refusal with no figure yet (refused before the first reading) is kept, with no figure.
 */
export function fableAllowance(
  used: [EpochMs, number] | null,
  resets: [EpochMs, number] | null,
  refused: [EpochMs, number] | null,
): FableAllowance | null {
  const refusedUntil = refused === null || refused[1] <= 0 ? null : refused[0] + refused[1] * 1000
  if (used === null && refusedUntil === null) return null
  return {
    usedFraction: used === null ? null : Math.min(1, Math.max(0, used[1])),
    resetsAt: resets === null || resets[1] <= 0 ? null : resets[0] + resets[1] * 1000,
    refusedUntil,
  }
}

/**
 * The 5-hour window as last read, with its reset time even when that has passed: whoever reads
 * it judges, at their own time, whether the window is still open (fiveHourAt). A countdown of
 * zero or less was read as the window reset, so it reset when it was read.
 */
export function fiveHourWindow(
  utilization: [EpochMs, number] | undefined,
  resets: [EpochMs, number] | undefined,
): QuotaWindow | null {
  if (utilization === undefined) return null
  const resetsAt = resets === undefined ? null : resets[0] + Math.max(0, resets[1]) * 1000
  return { usedFraction: utilization[1], resetsAt, lengthMs: FIVE_HOURS_MS }
}
const MAX_CACHE_ENTRIES = 512

/** One group's readings from one query: the label CloudWatch gave it and its points, ascending. */
export interface InsightsResult {
  label: string
  points: Array<[EpochMs, number]>
}

// The JSON protocol's wire shapes, as CloudWatch answers them.
interface WireResult {
  Id?: string
  Label?: string
  Timestamps?: number[]
  Values?: number[]
  StatusCode?: string
}
interface WireResponse {
  MetricDataResults?: WireResult[]
  NextToken?: string
  Messages?: Array<{ Code?: string; Value?: string }>
  __type?: string
  message?: string
  Message?: string
}

// Metrics Insights keywords that must be quoted as identifiers (the catalog keeps the same list).
const RESERVED = new Set(['result', 'window', 'from', 'to', 'type', 'value'])
const identifier = (name: string) => (RESERVED.has(name) ? `"${name}"` : name)

/**
 * A Metrics Insights query over the namespace: a statistic of a metric, optionally filtered on
 * one dimension and grouped by one or two. The snapshot's gauges are not semantic metrics (they
 * are read once, as "now"), so they are written here rather than in the catalog.
 */
export function gaugeQuery(
  namespace: string,
  statistic: 'MAX' | 'MIN' | 'SUM',
  metric: string,
  options: { where?: [string, string] | Array<[string, string]>; groupBy?: readonly string[] } = {},
): string {
  const conditions: Array<[string, string]> =
    options.where === undefined
      ? []
      : typeof options.where[0] === 'string'
        ? [options.where as [string, string]]
        : (options.where as Array<[string, string]>)
  const where =
    conditions.length === 0
      ? ''
      : ` WHERE ${conditions.map(([name, value]) => `${identifier(name)} = '${value.replace(/'/g, "''")}'`).join(' AND ')}`
  const group =
    options.groupBy === undefined || options.groupBy.length === 0
      ? ''
      : ` GROUP BY ${options.groupBy.map(identifier).join(', ')}`
  return `SELECT ${statistic}("${metric}") FROM "${namespace}"${where}${group}`
}

/** Maps claude-master's band gauge (0 ok, 1 reserve, 2 exhausted, anything else unknown). */
export function bandFromGauge(value: number | null): Band {
  switch (value) {
    case 0:
      return 'ok'
    case 1:
      return 'reserve'
    case 2:
      return 'exhausted'
    default:
      return 'unknown'
  }
}

/** The newest reading of a group, as [bucket start, value]; null with no points. */
/** The banked resets from their gauges: null when neither is reported. */
export function bankedResets(
  weekly: [EpochMs, number] | null,
  fable: [EpochMs, number] | null,
): BankedResets | null {
  if (weekly === null && fable === null) return null
  const count = (r: [EpochMs, number] | null) =>
    r === null || !Number.isFinite(r[1]) ? 0 : Math.max(0, Math.round(r[1]))
  return { weekly: count(weekly), fable: count(fable) }
}

/** A reserve's share of the week from its gauge: null for none (no reading, or zero). */
export function reserveShare(reading: [EpochMs, number] | null): number | null {
  if (reading === null || !Number.isFinite(reading[1]) || reading[1] <= 0) return null
  return Math.min(1, reading[1])
}

export function latest(result: InsightsResult | undefined): [EpochMs, number] | null {
  const point = result?.points.at(-1)
  return point === undefined ? null : point
}

/** Splits a two-dimension group label ("<first> <second>") at its last space. */
export function splitLabel(label: string): [string, string] {
  const at = label.lastIndexOf(' ')
  return at < 0 ? [label, ''] : [label.slice(0, at), label.slice(at + 1)]
}

/**
 * The waits before retrying a throttled call. A page load asks for about forty queries at once,
 * and CloudWatch throttles Metrics Insights when too many run together: spread over a few seconds,
 * they get through.
 */
export const DEFAULT_THROTTLE_RETRIES_MS: readonly number[] = [400, 1200, 3000]

/** Whether CloudWatch refused a call for its rate, not for the call itself. */
const throttled = (error: unknown): boolean =>
  error instanceof CloudWatchError &&
  (error.code === 'ThrottlingException' || error.code === 'Throttling' || error.status === 429)

/** How many of the snapshot's queries run at once. */
export const SNAPSHOT_QUERIES_AT_ONCE = 4

/** The most series one Metrics Insights query returns; past it, the rest are left out. */
export const MAX_INSIGHTS_SERIES = 500

interface CacheEntry {
  expiresAt: EpochMs
  result: InsightsResult[]
}

export function createCloudWatchSource(options: CloudWatchSourceOptions): MetricsSource {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  const clock = options.now ?? Date.now
  const fetchImpl = options.fetch ?? fetch
  const endpoint = options.endpoint ?? `https://monitoring.${options.region}.amazonaws.com/`
  const aliases = options.accountAliases ?? new Map<string, string>()
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
    region: options.region,
    service: 'monitoring',
  })
  const cache = new Map<string, CacheEntry>()
  const retries = options.throttleRetriesMs ?? DEFAULT_THROTTLE_RETRIES_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  /** One call, retried after a wait while CloudWatch throttles it. */
  async function call(
    body: Record<string, unknown>,
    action = 'GetMetricData',
  ): Promise<WireResponse> {
    for (const wait of retries) {
      try {
        return await callOnce(body, action)
      } catch (error) {
        if (!throttled(error)) throw error
        await sleep(wait + Math.random() * wait)
      }
    }
    return callOnce(body, action)
  }

  async function callOnce(body: Record<string, unknown>, action: string): Promise<WireResponse> {
    const request = await client.sign(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': `GraniteServiceVersion20100801.${action}`,
      },
      body: JSON.stringify(body),
    })
    const response = await fetchImpl(request)
    const text = await response.text()
    let parsed: WireResponse = {}
    try {
      parsed = JSON.parse(text) as WireResponse
    } catch {
      if (response.ok) throw new CloudWatchError(response.status, 'InvalidResponse', 'not JSON')
    }
    if (!response.ok) {
      const code = (parsed.__type ?? 'HttpError').split('#').at(-1) ?? 'HttpError'
      throw new CloudWatchError(response.status, code, parsed.message ?? parsed.Message ?? text)
    }
    return parsed
  }

  /** Runs one Metrics Insights query over [start, end) at `periodSeconds`, following pages. */
  async function run(
    expression: string,
    start: EpochMs,
    end: EpochMs,
    periodSeconds: number,
  ): Promise<InsightsResult[]> {
    const groups = new Map<string, Array<[EpochMs, number]>>()
    let nextToken: string | undefined
    do {
      const response: WireResponse = await call({
        StartTime: Math.floor(start / 1000),
        EndTime: Math.floor(end / 1000),
        ScanBy: 'TimestampAscending',
        MetricDataQueries: [{ Id: 'q', Expression: expression, Period: periodSeconds }],
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      })
      for (const result of response.MetricDataResults ?? []) {
        if (result.StatusCode === 'InternalError') {
          throw new CloudWatchError(200, 'InternalError', 'a query result failed')
        }
        const label = result.Label ?? ''
        const points = groups.get(label) ?? []
        const stamps = result.Timestamps ?? []
        const values = result.Values ?? []
        for (const [i, stamp] of stamps.entries()) {
          const value = values[i]
          if (typeof stamp === 'number' && typeof value === 'number' && Number.isFinite(value)) {
            points.push([stamp * 1000, value])
          }
        }
        groups.set(label, points)
      }
      nextToken = response.NextToken
    } while (nextToken !== undefined)
    return [...groups.entries()].map(([label, points]) => ({
      label,
      points: points.sort((a, b) => a[0] - b[0]),
    }))
  }

  /**
   * The same query within a minute is answered once it has been answered. Only answers are
   * shared, never a request in flight: on Workers a promise belongs to the request that made it,
   * and another request waiting on it is cancelled when that one ends (the runtime reports it as
   * hung, a 500). A failure is not kept: the next caller asks CloudWatch again.
   */
  function cached(
    expression: string,
    start: EpochMs,
    end: EpochMs,
    periodSeconds: number,
  ): Promise<InsightsResult[]> {
    const now = clock()
    const key = `${expression}\n${start}\n${end}\n${periodSeconds}`
    const hit = cache.get(key)
    if (hit !== undefined && hit.expiresAt > now) return Promise.resolve(hit.result)
    return run(expression, start, end, periodSeconds).then((result) => {
      const at = clock()
      for (const [k, entry] of cache) if (entry.expiresAt <= at) cache.delete(k)
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, { expiresAt: at + cacheMs, result })
      return result
    })
  }

  // The gauges the snapshot reads; one query each, all in flight together.
  const gauge = (statistic: 'MAX' | 'MIN', metric: string, groupBy: readonly string[]) =>
    gaugeQuery(namespace, statistic, `claw_master.${metric}`, { groupBy })

  // The alarms, read at most once a minute (an answer, not a request in flight, as `cached`).
  let alarmsCache: { expiresAt: EpochMs; alarms: AlarmStatus[] } | null = null

  return {
    async alarms(): Promise<AlarmStatus[]> {
      const now = clock()
      if (alarmsCache !== null && alarmsCache.expiresAt > now) return alarmsCache.alarms
      const alarms: AlarmStatus[] = []
      let nextToken: string | undefined
      do {
        const page = (await call(
          {
            AlarmNamePrefix: ALARM_PREFIX,
            AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
            MaxRecords: 100,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
          },
          'DescribeAlarms',
        )) as WireAlarms
        for (const alarm of [...(page.MetricAlarms ?? []), ...(page.CompositeAlarms ?? [])]) {
          const state = alarm.StateValue
          if (state !== 'ALARM' && state !== 'OK' && state !== 'INSUFFICIENT_DATA') continue
          if (typeof alarm.AlarmName !== 'string') continue
          const updated = alarm.StateUpdatedTimestamp
          alarms.push({
            name: alarm.AlarmName,
            state,
            since: typeof updated === 'number' ? updated * 1000 : Date.parse(String(updated)),
          })
        }
        nextToken = page.NextToken
      } while (nextToken !== undefined)
      alarmsCache = { expiresAt: clock() + cacheMs, alarms }
      return alarms
    },

    async snapshot(): Promise<Snapshot> {
      const now = clock()
      const end = Math.floor(now / 60_000) * 60_000 + 60_000
      const start = end - SNAPSHOT_LOOKBACK_MS
      // A few at a time: CloudWatch runs ten Metrics Insights queries a second per account.
      const turn = inTurn(SNAPSHOT_QUERIES_AT_ONCE)
      const read = (query: string, from = start) => turn(() => cached(query, from, end, 60))
      const weekHourEnd = Math.ceil(end / 3_600_000) * 3_600_000
      const [
        used,
        resets,
        bands,
        cooldowns,
        tokens,
        quantiles,
        fiveHour,
        polledFiveUsed,
        polledFiveResets,
        sessions,
        connections,
        verdicts,
        info,
        fableUsed,
        fableResets,
        fableRefused,
        reserveShares,
        weeklyBanked,
        fableBanked,
        fiveHourLimitedNow,
        fiveHourLimited,
      ] = await Promise.all([
        read(gauge('MAX', 'quota.used_fraction', ['profile'])),
        read(gauge('MAX', 'quota.resets_in_seconds', ['profile'])),
        read(gauge('MAX', 'quota.band', ['profile'])),
        read(gauge('MAX', 'quota.rate_limited_for_seconds', ['profile'])),
        read(gauge('MIN', 'auth.token_expires_in_seconds', ['profile'])),
        read(gauge('MAX', 'inference.duration_quantile', ['profile', 'quantile'])),
        read(
          gaugeQuery(namespace, 'MAX', 'claw_master.anthropic.ratelimit', {
            where: ['window', '5h'],
            groupBy: ['profile', 'measure'],
          }),
          end - FIVE_HOUR_LOOKBACK_MS,
        ),
        // From the usage poll, about once a minute whether the subscription serves or not
        // (exported by claude-master releases that have it).
        read(gauge('MAX', 'quota.five_hour.used_fraction', ['profile'])),
        read(gauge('MAX', 'quota.five_hour.resets_in_seconds', ['profile'])),
        read(gauge('MAX', 'sessions.tracked', [])),
        read(gauge('MAX', 'proxy.active_connections', [])),
        // Anthropic's overall verdict on each answer, counted per subscription: a minute with any
        // allowed or allowed_warning is a minute Anthropic took its work.
        read(
          gaugeQuery(namespace, 'SUM', 'claw_master.anthropic.ratelimit.state', {
            where: [
              ['measure', 'status'],
              ['window', 'all'],
            ],
            groupBy: ['profile', 'value'],
          }),
        ),
        // Which account each profile is logged in to (exported by claw-master releases that have it).
        read(gauge('MAX', 'profile.info', ['profile', 'email'])),
        // Each subscription's weekly Fable allowance (claw-master releases that have it).
        read(gauge('MAX', 'quota.fable.used_fraction', ['profile'])),
        read(gauge('MAX', 'quota.fable.resets_in_seconds', ['profile'])),
        read(gauge('MAX', 'quota.fable.rate_limited_for_seconds', ['profile'])),
        // How much of each week the owner's reserve holds back (claw-master releases that have it).
        read(gauge('MAX', 'quota.reserve_fraction', ['profile'])),
        // The resets each account has banked (claw-master releases that have them).
        read(gauge('MAX', 'quota.weekly.resets_left', ['profile'])),
        read(gauge('MAX', 'quota.fable.resets_left', ['profile'])),
        // Whether each plan has a 5-hour limit (claw-master releases that have it): the latest
        // minute, else the latest hour in a week. The week's query ends on the hour, so its answer
        // is reused for that hour.
        read(gauge('MAX', 'quota.five_hour.limited', ['profile'])),
        turn(() =>
          cached(
            gauge('MAX', 'quota.five_hour.limited', ['profile']),
            weekHourEnd - FIVE_HOUR_LIMIT_LOOKBACK_MS,
            weekHourEnd,
            3600,
          ),
        ),
      ])
      const byLabel = (results: InsightsResult[]) => new Map(results.map((r) => [r.label, r]))
      const resetsBy = byLabel(resets)
      const bandsBy = byLabel(bands)
      const cooldownsBy = byLabel(cooldowns)
      const polledFiveUsedBy = byLabel(polledFiveUsed)
      const polledFiveResetsBy = byLabel(polledFiveResets)
      const tokensBy = byLabel(tokens)
      const fableUsedBy = byLabel(fableUsed)
      const fableResetsBy = byLabel(fableResets)
      const fableRefusedBy = byLabel(fableRefused)
      const reserveBy = byLabel(reserveShares)
      const weeklyBankedBy = byLabel(weeklyBanked)
      const fableBankedBy = byLabel(fableBanked)
      const fiveHourLimitedNowBy = byLabel(fiveHourLimitedNow)
      const fiveHourLimitedBy = byLabel(fiveHourLimited)
      // Two-dimension groups: "<profile> <quantile>" and "<profile> <measure>".
      const quantilesBy = new Map<string, Partial<Record<string, number>>>()
      for (const result of quantiles) {
        const [profile, quantile] = splitLabel(result.label)
        const reading = latest(result)
        if (reading === null) continue
        quantilesBy.set(profile, { ...quantilesBy.get(profile), [quantile]: reading[1] })
      }
      // Not through at() either: when Anthropic last took a subscription's work says nothing of how
      // new the readings are.
      const acceptedBy = new Map<string, EpochMs>()
      for (const result of verdicts) {
        const [profile, value] = splitLabel(result.label)
        if (value !== 'allowed' && value !== 'allowed_warning') continue
        const minute = result.points.filter(([, count]) => count > 0).at(-1)?.[0]
        if (minute !== undefined && minute > (acceptedBy.get(profile) ?? -1))
          acceptedBy.set(profile, minute)
      }
      // Each profile's account: the email read most lately, should it have logged in to another.
      // Not through at() either: it says nothing of how new the readings are.
      const emailBy = new Map<string, { at: EpochMs; email: string }>()
      for (const result of info) {
        const [profile, email] = splitLabel(result.label)
        const reading = latest(result)
        if (reading === null || email === '') continue
        const known = emailBy.get(profile)
        if (known === undefined || reading[0] > known.at)
          emailBy.set(profile, { at: reading[0], email })
      }
      // Not through at(): an hours-old 5-hour reading does not make the snapshot newer or older.
      const fiveHourBy = new Map<string, Partial<Record<string, [EpochMs, number]>>>()
      for (const result of fiveHour) {
        const [profile, measure] = splitLabel(result.label)
        const reading = latest(result)
        if (reading === null) continue
        fiveHourBy.set(profile, { ...fiveHourBy.get(profile), [measure]: reading })
      }

      let asOf = 0
      const at = (reading: [EpochMs, number] | null) => {
        if (reading !== null && reading[0] > asOf) asOf = reading[0]
        return reading
      }
      // The proxy emits a band for every installed subscription, including -1 when usage is
      // unknown. Keep weekly-only reporters too; request-only backup and placeholder labels
      // never enter the inventory. Both gauges cover only the current snapshot window.
      const usedBy = byLabel(used)
      const names = new Set(
        [...bands, ...used].filter((r) => latest(r) !== null).map((r) => r.label),
      )
      const profiles: ProfileStatus[] = [...names]
        .map((profile) => {
          const weeklyUsed = at(latest(usedBy.get(profile)))
          const weeklyReset = at(latest(resetsBy.get(profile)))
          const band = at(latest(bandsBy.get(profile)))
          const cooldown = at(latest(cooldownsBy.get(profile)))
          const token = at(latest(tokensBy.get(profile)))
          const q = quantilesBy.get(profile) ?? {}
          const latencyMs: LatencyQuantiles = {
            p50: q['0.5'] ?? null,
            p95: q['0.95'] ?? null,
            p99: q['0.99'] ?? null,
          }
          // The usage poll's reading when there is one; else the last from the response headers.
          const polledUsed = latest(polledFiveUsedBy.get(profile))
          const window5h = fiveHourBy.get(profile)
          const utilization = polledUsed ?? window5h?.utilization
          // Not through at(): an hour-old answer says nothing of how new the snapshot is.
          const fiveHourLimit = fiveHourLimitFrom(
            latest(fiveHourLimitedNowBy.get(profile)) ?? latest(fiveHourLimitedBy.get(profile)),
          )
          const resets5h =
            polledUsed !== null
              ? (latest(polledFiveResetsBy.get(profile)) ?? undefined)
              : window5h?.resets_in_seconds
          return {
            profile,
            band: bandFromGauge(band === null ? null : band[1]),
            weekly: {
              usedFraction: weeklyUsed === null ? null : weeklyUsed[1],
              resetsAt:
                weeklyReset === null || weeklyReset[1] <= 0
                  ? null
                  : weeklyReset[0] + weeklyReset[1] * 1000,
              lengthMs: WEEK_MS,
            },
            // A plan with no 5-hour limit shows no 5-hour figure: the response headers can carry one
            // for hours after Anthropic drops the limit.
            fiveHour: fiveHourLimit === false ? null : fiveHourWindow(utilization, resets5h),
            fiveHourLimit,
            rateLimitedUntil:
              cooldown === null || cooldown[1] <= 0 ? null : cooldown[0] + cooldown[1] * 1000,
            tokenExpiresAt: token === null ? null : token[0] + token[1] * 1000,
            latencyMs,
            acceptedAt: acceptedBy.get(profile) ?? null,
            email: emailBy.get(profile)?.email ?? null,
            // Not through at(): a Fable reading says nothing of how new the snapshot is.
            fable: fableAllowance(
              latest(fableUsedBy.get(profile)),
              latest(fableResetsBy.get(profile)),
              latest(fableRefusedBy.get(profile)),
            ),
            reserveFraction: reserveShare(latest(reserveBy.get(profile))),
            bankedResets: bankedResets(
              latest(weeklyBankedBy.get(profile)),
              latest(fableBankedBy.get(profile)),
            ),
          }
        })
        .sort((a, b) => a.profile.localeCompare(b.profile))
      const sessionsNow = at(latest(sessions[0]))
      const connectionsNow = at(latest(connections[0]))
      return {
        asOf: asOf === 0 ? now : asOf,
        profiles,
        sessions: sessionsNow === null ? null : sessionsNow[1],
        activeConnections: connectionsNow === null ? null : connectionsNow[1],
      }
    },

    async series(query: SeriesQuery): Promise<Series[]> {
      validateSeriesQuery(query)
      const resolved = resolveMetric(query.metric, query.groupBy, query.tokenType, query.byType)
      const expression = insightsQuery(namespace, resolved)
      const { start, end } = query.range
      let results = await cached(expression, start, end, query.stepSeconds)
      // At the cap, some groups and types were left out: one query per type instead, labelled as
      // the grouped query labels them.
      if (
        resolved.byType === true &&
        resolved.byRate !== true &&
        results.length >= MAX_INSIGHTS_SERIES
      ) {
        const { byType: _, ...each } = resolved
        const types = await Promise.all(
          TOKEN_TYPES.map(async (tokenType) =>
            (
              await cached(
                insightsQuery(namespace, { ...each, tokenType }),
                start,
                end,
                query.stepSeconds,
              )
            ).map((r) => ({ ...r, label: `${r.label} ${tokenType}` })),
          ),
        )
        results = types.flat()
      }
      // Without GROUP BY, CloudWatch labels the one result with the query id. Split by rate too,
      // the label ends "<type> <rate>", keyed "<type>@<rate>" so the rate stays with the type.
      const keyOf = (label: string) => {
        if (resolved.byRate !== true) return label
        const [rest, rate] = splitLabel(label)
        return `${rest}@${rate}`
      }
      const series = results.map((result) => ({
        key: query.groupBy === undefined ? 'total' : keyOf(result.label),
        points: result.points,
      }))
      if (query.groupBy !== 'client_account') return series
      let map: ReadonlyMap<string, string>
      try {
        map = typeof aliases === 'function' ? await aliases() : aliases
      } catch {
        map = new Map<string, string>()
      }
      if (query.byType !== true) return foldAliases(series, map, resolved.statistic)
      // Each type's lines folded on their own, then keyed by group and type again.
      const types = new Map<string, Series[]>()
      for (const s of series) {
        const [group, type] = splitLabel(s.key)
        types.set(type, [...(types.get(type) ?? []), { key: group, points: s.points }])
      }
      return [...types].flatMap(([type, list]) =>
        foldAliases(list, map, resolved.statistic).map((s) => ({ ...s, key: `${s.key} ${type}` })),
      )
    },
  }
}

export type SourceKind = 'cloudwatch' | 'demo'

export interface SourceSelection {
  kind: SourceKind
  source: MetricsSource
}

/**
 * CloudWatch when AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION are all set, otherwise
 * the given demo source (and a warning naming what is missing, so an empty deployment is not
 * mistaken for a configured one). A CloudWatch failure later is an error, never a fallback.
 * accountAliases, when the caller passes them, fold account codes into people's names (the
 * reference app reads them from KV).
 */
export function selectSource(
  env: Record<string, string | undefined>,
  demo: MetricsSource,
  options: Omit<CloudWatchSourceOptions, 'accessKeyId' | 'secretAccessKey' | 'region'> & {
    warn?: (message: string) => void
  } = {},
): SourceSelection {
  const { warn = console.warn, ...rest } = options
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim()
  const region = env.AWS_REGION?.trim()
  if (accessKeyId && secretAccessKey && region) {
    return {
      kind: 'cloudwatch',
      source: createCloudWatchSource({
        ...rest,
        accessKeyId,
        secretAccessKey,
        region,
      }),
    }
  }
  const missing = [
    accessKeyId ? null : 'AWS_ACCESS_KEY_ID',
    secretAccessKey ? null : 'AWS_SECRET_ACCESS_KEY',
    region ? null : 'AWS_REGION',
  ].filter((name) => name !== null)
  warn(`claw-master dashboard: ${missing.join(', ')} not set; showing demo data`)
  return { kind: 'demo', source: demo }
}
