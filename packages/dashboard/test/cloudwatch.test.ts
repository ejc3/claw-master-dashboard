import { describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_ALIASES_KEY,
  bandFromGauge,
  CloudWatchError,
  createCloudWatchSource,
  DEFAULT_CACHE_MS,
  DEFAULT_THROTTLE_RETRIES_MS,
  FIVE_HOUR_LOOKBACK_MS,
  fiveHourWindow,
  foldAliases,
  gaugeQuery,
  parseAccountAliases,
  SNAPSHOT_LOOKBACK_MS,
  selectSource,
  splitLabel,
} from '../src/cloudwatch/index'
import { FIVE_HOURS_MS, fiveHourAt, HOUR_MS, type MetricsSource, WEEK_MS } from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { createDashboardHandler } from '../src/next/index'

// 2026-10-10T05:10:00Z, a whole minute, as the page's step-aligned ranges are.
const NOW = Date.UTC(2026, 9, 10, 5, 10)
const SEC = (ms: number) => Math.floor(ms / 1000)

// The shape CloudWatch's JSON protocol answers with, as recorded live (values made up): epoch
// seconds, one result per group, the GROUP BY values joined by a space as the label, and the
// query id as the label when there is no GROUP BY.
function result(label: string, points: Array<[number, number]>) {
  return {
    Id: 'q',
    Label: label,
    Timestamps: points.map(([t]) => SEC(t)),
    Values: points.map(([, v]) => v),
    StatusCode: 'Complete',
  }
}

type Answer = (body: Record<string, unknown>, expression: string) => unknown

/** A fake CloudWatch: records every signed request and answers from `answer`. */
function fakeCloudWatch(answer: Answer) {
  const requests: Array<{ request: Request; body: Record<string, unknown>; expression: string }> =
    []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request
    const body = JSON.parse(await request.clone().text()) as Record<string, unknown>
    const query = (body.MetricDataQueries as Array<{ Expression: string }> | undefined)?.[0]
    const expression = query?.Expression ?? ''
    requests.push({ request, body, expression })
    const answered = answer(body, expression)
    if (answered instanceof Response) return answered
    return Response.json(answered)
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests, calls: fetchImpl }
}

function source(answer: Answer, options: { now?: () => number; cacheMs?: number } = {}) {
  const fake = fakeCloudWatch(answer)
  // The waits before each retry, taken at once.
  const slept: number[] = []
  const src = createCloudWatchSource({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'example-secret',
    region: 'us-test-1',
    fetch: fake.fetchImpl,
    now: options.now ?? (() => NOW),
    sleep: async (ms) => {
      slept.push(ms)
    },
    ...(options.cacheMs === undefined ? {} : { cacheMs: options.cacheMs }),
  })
  return { src, slept, ...fake }
}

/** CloudWatch's answer to a call made while too many run. */
const throttledAnswer = () =>
  new Response(
    JSON.stringify({
      __type: 'com.amazon.coral.service#ThrottlingException',
      message: 'Query has been throttled',
    }),
    { status: 400 },
  )

const t0 = NOW - 10 * 60_000

// The snapshot's gauges for two made-up subscriptions, plus the backup and placeholder that
// report latency but no quota.
function snapshotAnswers(): Answer {
  const latest = t0 + 9 * 60_000
  return (_body, expression) => {
    const results = (() => {
      // The usage poll's 5-hour gauges (none here: the header readings stand).
      if (expression.includes('quota.five_hour.')) return []
      if (expression.includes('quota.used_fraction'))
        return [
          result('alpha', [
            [t0, 0.4],
            [latest, 0.42],
          ]),
          result('bravo', [[latest, 1]]),
        ]
      if (expression.includes('quota.resets_in_seconds'))
        return [result('alpha', [[latest, 3 * 24 * 3600]]), result('bravo', [[latest, 0]])]
      if (expression.includes('quota.band'))
        return [result('alpha', [[latest, 0]]), result('bravo', [[latest, 2]])]
      if (expression.includes('rate_limited_for_seconds'))
        return [result('alpha', [[latest, 0]]), result('bravo', [[latest, 420]])]
      if (expression.includes('token_expires_in_seconds'))
        return [result('alpha', [[latest, 16_000]]), result('bravo', [[latest, 15_000]])]
      if (expression.includes('duration_quantile'))
        return [
          result('alpha 0.5', [[latest, 3600]]),
          result('alpha 0.95', [[latest, 18_000]]),
          result('alpha 0.99', [[latest, 33_000]]),
          result('api-backup 0.5', [[latest, 660]]),
          result('none 0.5', [[latest, 100]]),
        ]
      if (expression.includes('anthropic.ratelimit.state'))
        return [
          // alpha: Anthropic took its work two minutes in and refused one later; bravo: refused only.
          result('alpha allowed', [
            [t0 + 2 * 60_000, 3],
            [t0 + 5 * 60_000, 0],
          ]),
          result('alpha rejected', [[t0 + 6 * 60_000, 1]]),
          result('alpha allowed_warning', [[t0 + 1 * 60_000, 1]]),
          result('bravo rejected', [[latest, 2]]),
        ]
      if (expression.includes('anthropic.ratelimit'))
        return [
          result('alpha utilization', [[latest, 0.32]]),
          result('alpha resets_in_seconds', [[latest, 14_000]]),
          result('alpha surpassed_threshold', [[latest, 0.9]]),
        ]
      if (expression.includes('sessions.tracked')) return [result('q', [[latest, 94]])]
      if (expression.includes('active_connections')) return [result('q', [[latest, 55]])]
      return []
    })()
    return { MetricDataResults: results, Messages: [] }
  }
}

describe('createCloudWatchSource', () => {
  it('signs one Metrics Insights query per GetMetricData call over the JSON protocol', async () => {
    const { src, requests } = source(() => ({ MetricDataResults: [] }))
    await src.series({
      metric: 'requests',
      groupBy: 'profile',
      range: { start: NOW - HOUR_MS, end: NOW },
      stepSeconds: 300,
    })
    expect(requests).toHaveLength(1)
    const [{ request, body }] = requests as [(typeof requests)[number]]
    expect(request.url).toBe('https://monitoring.us-test-1.amazonaws.com/')
    expect(request.method).toBe('POST')
    expect(request.headers.get('x-amz-target')).toBe('GraniteServiceVersion20100801.GetMetricData')
    expect(request.headers.get('content-type')).toBe('application/x-amz-json-1.0')
    expect(request.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-test-1\/monitoring\/aws4_request/,
    )
    expect(body.StartTime).toBe(SEC(NOW - HOUR_MS))
    expect(body.EndTime).toBe(SEC(NOW))
    expect(body.ScanBy).toBe('TimestampAscending')
    expect(body.MetricDataQueries).toEqual([
      {
        Id: 'q',
        Expression:
          'SELECT SUM("claw_master.inference.requests") FROM "ClawMaster" GROUP BY profile',
        Period: 300,
      },
    ])
  })

  it('turns results into series: ms timestamps, ascending, the label as the key', async () => {
    const { src } = source(() => ({
      MetricDataResults: [
        result('bravo', [
          [t0 + 300_000, 3],
          [t0, 5],
        ]),
        result('alpha', [[t0, 7]]),
      ],
    }))
    const series = await src.series({
      metric: 'requests',
      groupBy: 'profile',
      range: { start: t0, end: NOW },
      stepSeconds: 300,
    })
    expect(series).toEqual([
      {
        key: 'bravo',
        points: [
          [t0, 5],
          [t0 + 300_000, 3],
        ],
      },
      { key: 'alpha', points: [[t0, 7]] },
    ])
  })

  it('names an ungrouped query total and follows NextToken pages', async () => {
    let page = 0
    const { src, requests } = source((body) => {
      page++
      if (body.NextToken === undefined) {
        return { MetricDataResults: [result('q', [[t0, 1]])], NextToken: 'page-2' }
      }
      return { MetricDataResults: [result('q', [[t0 + 300_000, 2]])] }
    })
    const series = await src.series({
      metric: 'backupRequests',
      range: { start: t0, end: NOW },
      stepSeconds: 300,
    })
    expect(page).toBe(2)
    expect(requests[1]?.body.NextToken).toBe('page-2')
    expect(series).toEqual([
      {
        key: 'total',
        points: [
          [t0, 1],
          [t0 + 300_000, 2],
        ],
      },
    ])
  })

  it('refuses a split claude-master does not emit before any request', async () => {
    const { src, calls } = source(() => ({ MetricDataResults: [] }))
    await expect(
      src.series({
        metric: 'errors',
        groupBy: 'model',
        range: { start: t0, end: NOW },
        stepSeconds: 300,
      }),
    ).rejects.toThrow(/does not emit/)
    expect(calls).not.toHaveBeenCalled()
  })

  it('answers the same query from its answer for a minute, never by sharing a request in flight', async () => {
    let now = NOW
    const { src, calls } = source(() => ({ MetricDataResults: [result('q', [[t0, 1]])] }), {
      now: () => now,
    })
    const query = {
      metric: 'backupRequests' as const,
      range: { start: t0, end: NOW },
      stepSeconds: 300,
    }
    // Concurrent callers (on Workers, other requests) each ask: a promise in flight belongs to
    // the request that made it, and waiting on it from another one is cancelled with it.
    await Promise.all([src.series(query), src.series(query), src.series(query)])
    expect(calls).toHaveBeenCalledTimes(3)
    // Once answered, the answer is shared for a minute.
    await src.series(query)
    expect(calls).toHaveBeenCalledTimes(3)
    await src.series({ ...query, range: { start: t0 - 300_000, end: NOW } })
    expect(calls).toHaveBeenCalledTimes(4)
    now += DEFAULT_CACHE_MS
    await src.series(query)
    expect(calls).toHaveBeenCalledTimes(5)
  })

  it('retries a throttled call after a growing wait, and answers once it gets through', async () => {
    let refusals = 2
    const { src, calls, slept } = source(() =>
      refusals-- > 0 ? throttledAnswer() : { MetricDataResults: [result('q', [[t0, 1]])] },
    )
    const answer = await src.series({
      metric: 'backupRequests',
      range: { start: t0, end: NOW },
      stepSeconds: 300,
    })
    expect(answer).toHaveLength(1)
    expect(calls).toHaveBeenCalledTimes(3)
    expect(slept).toHaveLength(2)
    // Each wait is its step plus up to as much again.
    const [first = 0, second = 0] = DEFAULT_THROTTLE_RETRIES_MS
    expect(slept[0]).toBeGreaterThanOrEqual(first)
    expect(slept[0]).toBeLessThan(2 * first)
    expect(slept[1]).toBeGreaterThanOrEqual(second)
    expect(slept[1]).toBeLessThan(2 * second)
  })

  it('does not retry a refusal that is not throttling', async () => {
    const { src, calls } = source(
      () =>
        new Response(
          JSON.stringify({ __type: 'com.amazon.coral.service#InvalidParameterValueException' }),
          { status: 400 },
        ),
    )
    const error = await src
      .series({ metric: 'backupRequests', range: { start: t0, end: NOW }, stepSeconds: 300 })
      .catch((e: unknown) => e)
    expect((error as CloudWatchError).code).toBe('InvalidParameterValueException')
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('does not keep a failure: the next caller asks again', async () => {
    let fail = true
    const { src, calls } = source(() =>
      fail ? throttledAnswer() : { MetricDataResults: [result('q', [[t0, 1]])] },
    )
    const query = {
      metric: 'backupRequests' as const,
      range: { start: t0, end: NOW },
      stepSeconds: 300,
    }
    const error = await src.series(query).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudWatchError)
    expect((error as CloudWatchError).code).toBe('ThrottlingException')
    expect((error as CloudWatchError).status).toBe(400)
    // Every retry was refused too.
    expect(calls).toHaveBeenCalledTimes(DEFAULT_THROTTLE_RETRIES_MS.length + 1)
    fail = false
    expect(await src.series(query)).toHaveLength(1)
    expect(calls).toHaveBeenCalledTimes(DEFAULT_THROTTLE_RETRIES_MS.length + 2)
  })

  it('composes the snapshot from the gauges, one query each', async () => {
    const { src, requests } = source(snapshotAnswers())
    const snapshot = await src.snapshot()
    const latest = t0 + 9 * 60_000
    expect(requests).toHaveLength(13)
    const expressions = requests.map((r) => r.expression)
    expect(expressions).toContain(
      'SELECT MAX("claw_master.quota.used_fraction") FROM "ClawMaster" GROUP BY profile',
    )
    expect(expressions).toContain(
      'SELECT MAX("claw_master.inference.duration_quantile") FROM "ClawMaster" GROUP BY profile, quantile',
    )
    expect(expressions).toContain(
      'SELECT MAX("claw_master.anthropic.ratelimit") FROM "ClawMaster" WHERE "window" = \'5h\' GROUP BY profile, measure',
    )
    expect(expressions).toContain('SELECT MAX("claw_master.sessions.tracked") FROM "ClawMaster"')
    expect(expressions).toContain(
      'SELECT SUM("claw_master.anthropic.ratelimit.state") FROM "ClawMaster" WHERE measure = \'status\' AND "window" = \'all\' GROUP BY profile, "value"',
    )
    for (const { body, expression } of requests) {
      expect(body.EndTime).toBe(SEC(NOW + 60_000))
      // The 5-hour reading is looked for over its whole window; the rest over minutes.
      expect(body.StartTime).toBe(
        SEC(
          NOW +
            60_000 -
            (expression.includes('anthropic.ratelimit")')
              ? FIVE_HOUR_LOOKBACK_MS
              : SNAPSHOT_LOOKBACK_MS),
        ),
      )
    }
    expect(snapshot.asOf).toBe(latest)
    expect(snapshot.sessions).toBe(94)
    expect(snapshot.activeConnections).toBe(55)
    // Only subscriptions (those with a weekly share), sorted; the backup and 'none' are not listed.
    expect(snapshot.profiles.map((p) => p.profile)).toEqual(['alpha', 'bravo'])
    const [alpha, bravo] = snapshot.profiles as [
      (typeof snapshot.profiles)[number],
      (typeof snapshot.profiles)[number],
    ]
    expect(alpha.band).toBe('ok')
    expect(alpha.weekly).toEqual({
      usedFraction: 0.42,
      resetsAt: latest + 3 * 24 * 3600 * 1000,
      lengthMs: WEEK_MS,
    })
    expect(alpha.fiveHour).toEqual({
      usedFraction: 0.32,
      resetsAt: latest + 14_000 * 1000,
      lengthMs: FIVE_HOURS_MS,
    })
    expect(alpha.rateLimitedUntil).toBeNull()
    expect(alpha.tokenExpiresAt).toBe(latest + 16_000 * 1000)
    expect(alpha.latencyMs).toEqual({ p50: 3600, p95: 18_000, p99: 33_000 })
    expect(bravo.band).toBe('exhausted')
    expect(bravo.weekly.resetsAt).toBeNull()
    expect(bravo.fiveHour).toBeNull()
    expect(bravo.rateLimitedUntil).toBe(latest + 420_000)
    expect(bravo.latencyMs).toEqual({ p50: null, p95: null, p99: null })
    // The last minute Anthropic took its work (a refusal is not that); none for bravo.
    expect(alpha.acceptedAt).toBe(t0 + 2 * 60_000)
    expect(bravo.acceptedAt).toBeNull()
  })

  it('keeps a 5-hour reading from hours ago while its window runs, and none once it has reset', async () => {
    // A subscription whose 5-hour window filled stops serving, so its reading stops coming.
    const latest = t0 + 9 * 60_000
    const old = NOW - 3 * 3600_000
    const answers = snapshotAnswers()
    const { src } = source((body, expression) => {
      if (!expression.includes('anthropic.ratelimit')) return answers(body, expression)
      return {
        MetricDataResults: [
          // alpha: full, read three hours ago, resets an hour from now.
          result('alpha utilization', [[old, 1]]),
          result('alpha resets_in_seconds', [[old, 4 * 3600]]),
          // bravo: read three hours ago, reset an hour ago: no window open now.
          result('bravo utilization', [[old, 0.7]]),
          result('bravo resets_in_seconds', [[old, 2 * 3600]]),
        ],
        Messages: [],
      }
    })
    const snapshot = await src.snapshot()
    const [alpha, bravo] = snapshot.profiles
    expect(alpha?.fiveHour).toEqual({
      usedFraction: 1,
      resetsAt: old + 4 * 3600_000,
      lengthMs: FIVE_HOURS_MS,
    })
    // Passed on as read; whoever uses it judges it closed at their own time.
    expect(bravo?.fiveHour).toEqual({
      usedFraction: 0.7,
      resetsAt: old + 2 * 3600_000,
      lengthMs: FIVE_HOURS_MS,
    })
    expect(fiveHourAt(bravo?.fiveHour ?? null, NOW)).toEqual({
      usedFraction: 0,
      resetsAt: null,
      lengthMs: FIVE_HOURS_MS,
    })
    expect(fiveHourAt(alpha?.fiveHour ?? null, NOW)).toEqual(alpha?.fiveHour)
    // The old reading does not make the snapshot older.
    expect(snapshot.asOf).toBe(latest)
  })

  it('names the account each profile is logged in to, the latest when it changed', async () => {
    const latest = t0 + 9 * 60_000
    const answers = snapshotAnswers()
    const { src, requests } = source((body, expression) => {
      if (expression.includes('profile.info'))
        return {
          MetricDataResults: [
            result('alpha old@example.com', [[latest - 5 * 60_000, 1]]),
            result('alpha new@example.com', [[latest, 1]]),
          ],
          Messages: [],
        }
      return answers(body, expression)
    })
    const snapshot = await src.snapshot()
    expect(requests.map((r) => r.expression)).toContain(
      'SELECT MAX("claw_master.profile.info") FROM "ClawMaster" GROUP BY profile, email',
    )
    const email = (name: string) => snapshot.profiles.find((p) => p.profile === name)?.email
    expect(email('alpha')).toBe('new@example.com')
    // None reported: null, not a guess.
    expect(email('bravo')).toBeNull()
  })

  it("takes the usage poll's 5-hour reading over the response headers' when there is one", async () => {
    const latest = t0 + 9 * 60_000
    const answers = snapshotAnswers()
    const { src } = source((body, expression) => {
      if (expression.includes('quota.five_hour.used_fraction'))
        return { MetricDataResults: [result('alpha', [[latest, 0.81]])], Messages: [] }
      if (expression.includes('quota.five_hour.resets_in_seconds'))
        return { MetricDataResults: [result('alpha', [[latest, 600]])], Messages: [] }
      return answers(body, expression)
    })
    const snapshot = await src.snapshot()
    const alpha = snapshot.profiles.find((p) => p.profile === 'alpha')
    // The headers said 0.32, resetting in 14000 s; the poll is the one kept.
    expect(alpha?.fiveHour).toEqual({
      usedFraction: 0.81,
      resetsAt: latest + 600_000,
      lengthMs: FIVE_HOURS_MS,
    })
  })

  it('reads a countdown of zero as a window that reset when it was read', () => {
    expect(fiveHourWindow([NOW - 3600_000, 1], [NOW - 3600_000, 0])).toEqual({
      usedFraction: 1,
      resetsAt: NOW - 3600_000,
      lengthMs: FIVE_HOURS_MS,
    })
    expect(
      fiveHourAt(fiveHourWindow([NOW - 3600_000, 1], [NOW - 3600_000, 0]), NOW)?.usedFraction,
    ).toBe(0)
    // No countdown read at all: the reset time is unknown, and the reading stands.
    expect(fiveHourWindow([NOW, 0.4], undefined)?.resetsAt).toBeNull()
  })

  it("reads claude-master's alarms: name, state and since when", async () => {
    const { src, requests } = source(() => ({
      MetricAlarms: [
        {
          AlarmName: 'claude-master-upstream-errors',
          StateValue: 'ALARM',
          StateUpdatedTimestamp: (NOW - 600_000) / 1000,
        },
        {
          AlarmName: 'claude-master-server-swapping',
          StateValue: 'OK',
          StateUpdatedTimestamp: (NOW - 3_600_000) / 1000,
        },
        { AlarmName: 'claude-master-odd', StateValue: 'WEIRD', StateUpdatedTimestamp: 0 },
      ],
    }))
    const alarms = await src.alarms?.()
    expect(alarms).toEqual([
      { name: 'claude-master-upstream-errors', state: 'ALARM', since: NOW - 600_000 },
      { name: 'claude-master-server-swapping', state: 'OK', since: NOW - 3_600_000 },
    ])
    // DescribeAlarms, for claude-master's alarms only.
    expect(requests[0]?.request.headers.get('x-amz-target')).toBe(
      'GraniteServiceVersion20100801.DescribeAlarms',
    )
    expect(requests[0]?.body.AlarmNamePrefix).toBe('claude-master')
    // Read once a minute.
    await src.alarms?.()
    expect(requests).toHaveLength(1)
  })

  it('answers 403 with a plain message when the key may not read alarms', async () => {
    const { src } = source(
      () =>
        new Response(JSON.stringify({ __type: 'AccessDenied', message: 'not authorized' }), {
          status: 403,
        }),
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const GET = createDashboardHandler({ source: () => src, authorize: () => true }).GET
    const response = await GET(new Request('https://example.test/api/claude-master/alarms'))
    log.mockRestore()
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe(
      "The dashboard's AWS key cannot read alarms yet.",
    )
  })

  it('has no profiles and the clock as asOf when nothing has been exported', async () => {
    const { src } = source(() => ({ MetricDataResults: [] }))
    const snapshot = await src.snapshot()
    expect(snapshot).toEqual({ asOf: NOW, profiles: [], sessions: null, activeConnections: null })
  })

  it('reaches the handler as a 502, never as demo data', async () => {
    const { src } = source(
      () =>
        new Response(JSON.stringify({ __type: 'AccessDeniedException', message: 'no' }), {
          status: 403,
        }),
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const GET = createDashboardHandler({ source: () => src, authorize: () => true }).GET
    const response = await GET(new Request('https://example.test/api/claude-master/snapshot'))
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('alpha')
    log.mockRestore()
  })
})

describe('helpers', () => {
  it('quotes reserved identifiers and escapes the filter value', () => {
    expect(
      gaugeQuery('ClawMaster', 'MAX', 'claw_master.anthropic.ratelimit', {
        where: ['window', "5h'x"],
        groupBy: ['profile', 'measure'],
      }),
    ).toBe(
      'SELECT MAX("claw_master.anthropic.ratelimit") FROM "ClawMaster" WHERE "window" = \'5h\'\'x\' GROUP BY profile, measure',
    )
    expect(gaugeQuery('ClawMaster', 'MIN', 'claw_master.x')).toBe(
      'SELECT MIN("claw_master.x") FROM "ClawMaster"',
    )
  })

  it('maps the band gauge and splits two-dimension labels', () => {
    expect([0, 1, 2, -1, null, 7].map(bandFromGauge)).toEqual([
      'ok',
      'reserve',
      'exhausted',
      'unknown',
      'unknown',
      'unknown',
    ])
    expect(splitLabel('alpha 0.95')).toEqual(['alpha', '0.95'])
    expect(splitLabel('q')).toEqual(['q', ''])
  })
})

describe('selectSource', () => {
  const demo: MetricsSource = createDemoSource({ now: () => NOW })

  it('picks CloudWatch when the key is complete', () => {
    const warn = vi.fn()
    const chosen = selectSource(
      { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'x', AWS_REGION: 'us-test-1' },
      demo,
      { warn, fetch: vi.fn() as unknown as typeof fetch },
    )
    expect(chosen.kind).toBe('cloudwatch')
    expect(chosen.source).not.toBe(demo)
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to the demo fixture, naming what is missing, otherwise', () => {
    const warn = vi.fn()
    const chosen = selectSource({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_REGION: ' ' }, demo, {
      warn,
    })
    expect(chosen).toEqual({ kind: 'demo', source: demo })
    expect(warn).toHaveBeenCalledWith(
      'claw-master dashboard: AWS_SECRET_ACCESS_KEY, AWS_REGION not set; showing demo data',
    )
  })
})

describe('DashboardPage', () => {
  it('passes the demo label through to the page', async () => {
    const { DashboardPage } = await import('../src/next/index')
    const element = (await DashboardPage({
      source: () => createDemoSource({ now: () => NOW }),
      authorize: () => true,
      unauthorized: 'sign in',
      apiBase: '/api/claude-master',
      demoData: true,
    })) as { props: { demoData?: boolean } }
    expect(element.props.demoData).toBe(true)
  })
})

describe('account aliases', () => {
  const t1 = t0 + 5 * 60_000
  const byPerson = () => ({
    MetricDataResults: [
      result('acct-0000aaaa', [[t0, 2]]),
      result('alpha', [
        [t0, 1],
        [t1, 3],
      ]),
      result('acct-0000cccc', [[t0, 5]]),
    ],
  })
  const query = {
    metric: 'requests' as const,
    groupBy: 'client_account' as const,
    range: { start: NOW - HOUR_MS, end: NOW },
    stepSeconds: 300,
  }

  it('reads one acct-<hash>=NAME line per person and counts, never names, the malformed ones', () => {
    const warn = vi.fn()
    const aliases = parseAccountAliases(
      '# people\nacct-0000aaaa=alpha\n\n acct-0000bbbb = bravo \nnot-a-code=x\nacct-0000dddd=\nacct-ZZ=y',
      warn,
    )
    expect([...aliases]).toEqual([
      ['acct-0000aaaa', 'alpha'],
      ['acct-0000bbbb', 'bravo'],
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]?.[0] as string
    expect(message).toBe('claw-master dashboard: 3 malformed lines in the account aliases ignored')
    expect(message).not.toContain('not-a-code')
    expect(parseAccountAliases(undefined, warn).size).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('gives each person one series when the aliases are set, summing a shared bucket', async () => {
    const fake = fakeCloudWatch(byPerson)
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fake.fetchImpl,
      now: () => NOW,
      accountAliases: new Map([['acct-0000aaaa', 'alpha']]),
    })
    const series = await src.series(query)
    expect(series).toEqual([
      {
        key: 'alpha',
        points: [
          [t0, 3],
          [t1, 3],
        ],
      },
      { key: 'acct-0000cccc', points: [[t0, 5]] },
    ])
  })

  it('changes nothing without aliases, or for a split other than by person', async () => {
    const { src } = source(byPerson)
    expect((await src.series(query)).map((s) => s.key)).toEqual([
      'acct-0000aaaa',
      'alpha',
      'acct-0000cccc',
    ])
    const fake = fakeCloudWatch(byPerson)
    const aliased = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fake.fetchImpl,
      now: () => NOW,
      accountAliases: new Map([['acct-0000aaaa', 'alpha']]),
    })
    const byProfile = await aliased.series({ ...query, groupBy: 'profile' })
    expect(byProfile.map((s) => s.key)).toEqual(['acct-0000aaaa', 'alpha', 'acct-0000cccc'])
  })

  it('takes the larger value, not the sum, for a metric that is not a SUM', () => {
    const folded = foldAliases(
      [
        { key: 'acct-0000aaaa', points: [[t0, 4]] },
        { key: 'alpha', points: [[t0, 7]] },
      ],
      new Map([['acct-0000aaaa', 'alpha']]),
      'AVG',
    )
    expect(folded).toEqual([{ key: 'alpha', points: [[t0, 7]] }])
  })

  it('asks an aliases function on every split by person, and shows the series unfolded if it fails', async () => {
    let current: ReadonlyMap<string, string> = new Map([['acct-0000aaaa', 'alpha']])
    let fail = false
    const asked = vi.fn(async () => {
      if (fail) throw new Error('KV unavailable')
      return current
    })
    const fake = fakeCloudWatch(byPerson)
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fake.fetchImpl,
      now: () => NOW,
      accountAliases: asked,
    })
    expect((await src.series(query)).map((s) => s.key)).toEqual(['alpha', 'acct-0000cccc'])
    current = new Map([['acct-0000cccc', 'charlie']])
    expect((await src.series(query)).map((s) => s.key)).toEqual([
      'acct-0000aaaa',
      'alpha',
      'charlie',
    ])
    fail = true
    expect((await src.series(query)).map((s) => s.key)).toEqual([
      'acct-0000aaaa',
      'alpha',
      'acct-0000cccc',
    ])
    // Not asked for a split that is not by person.
    const calls = asked.mock.calls.length
    await src.series({ ...query, groupBy: 'profile' })
    expect(asked.mock.calls.length).toBe(calls)
  })

  it('names where malformed lines came from', () => {
    const warn = vi.fn()
    parseAccountAliases('nope', warn, 'DASHBOARD_CONFIG/account-aliases')
    expect(warn).toHaveBeenCalledWith(
      'claw-master dashboard: 1 malformed line in DASHBOARD_CONFIG/account-aliases ignored',
    )
    expect(ACCOUNT_ALIASES_KEY).toBe('account-aliases')
  })

  it('takes the aliases from the caller in selectSource, never from an environment setting', async () => {
    const fake = fakeCloudWatch(byPerson)
    const env = {
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'x',
      AWS_REGION: 'us-test-1',
    }
    const chosen = selectSource(env, createDemoSource({ now: () => NOW }), {
      warn: vi.fn(),
      fetch: fake.fetchImpl,
      now: () => NOW,
      accountAliases: async () =>
        new Map([
          ['acct-0000aaaa', 'alpha'],
          ['acct-0000cccc', 'charlie'],
        ]),
    })
    expect((await chosen.source.series(query)).map((s) => s.key)).toEqual(['alpha', 'charlie'])
    const plain = selectSource(env, createDemoSource({ now: () => NOW }), {
      warn: vi.fn(),
      fetch: fakeCloudWatch(byPerson).fetchImpl,
      now: () => NOW,
    })
    expect((await plain.source.series(query)).map((s) => s.key)).toEqual([
      'acct-0000aaaa',
      'alpha',
      'acct-0000cccc',
    ])
  })
})
