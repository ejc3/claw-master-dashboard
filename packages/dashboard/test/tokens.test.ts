import { describe, expect, it } from 'vitest'
import { createCloudWatchSource, MAX_INSIGHTS_SERIES } from '../src/cloudwatch/index'
import {
  BadQueryError,
  firstPointAt,
  fromFirstBucket,
  HOUR_MS,
  insightsQuery,
  resolveMetric,
  type Series,
  type SeriesQuery,
  seriesQueryFromParams,
  seriesQueryToParams,
  TOKEN_TYPES,
  tokenCoverage,
  tokenRows,
  tokensBetween,
  tokensByType,
  tokensOfType,
  UnsupportedQueryError,
} from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { requestTable, tableRangeWords } from '../src/react/Breakdown'
import { firstQueries, queryKey, tabQueries } from '../src/react/queries'

const NOW = Date.UTC(2026, 9, 10, 6)
const STEP = 300
const range = { start: NOW - 2 * HOUR_MS, end: NOW }
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000

describe('tokens in the catalog', () => {
  it('reads the token counters, filtered by type and split by subscription, person or machine', () => {
    expect(insightsQuery('ClawMaster', resolveMetric('tokens', 'profile'))).toBe(
      'SELECT SUM("claw_master.inference.tokens") FROM "ClawMaster" GROUP BY profile',
    )
    expect(insightsQuery('ClawMaster', resolveMetric('tokens', 'type'))).toBe(
      'SELECT SUM("claw_master.inference.tokens") FROM "ClawMaster" GROUP BY "type"',
    )
    expect(
      insightsQuery('ClawMaster', resolveMetric('tokens', 'client_account', 'cache_read')),
    ).toBe(
      `SELECT SUM("claw_master.inference.tokens.by_client_account") FROM "ClawMaster" WHERE "type" = 'cache_read' GROUP BY client_account`,
    )
    expect(insightsQuery('ClawMaster', resolveMetric('tokens', 'client', 'input'))).toBe(
      `SELECT SUM("claw_master.inference.tokens.by_client") FROM "ClawMaster" WHERE "type" = 'input' GROUP BY client`,
    )
  })

  it('has no token split by model, and no token type on another metric', () => {
    expect(() => resolveMetric('tokens', 'model')).toThrow(UnsupportedQueryError)
    expect(() => resolveMetric('requests', 'profile', 'input')).toThrow(UnsupportedQueryError)
  })
})

describe('the token type on the wire', () => {
  const query: SeriesQuery = {
    metric: 'tokens',
    groupBy: 'client',
    tokenType: 'cache_creation',
    range,
    stepSeconds: STEP,
  }

  it('round-trips', () => {
    expect(seriesQueryFromParams(seriesQueryToParams(query))).toEqual(query)
  })

  it('is refused on another metric, when unknown, or together with a split by type', () => {
    const params = (extra: Record<string, string>) =>
      new URLSearchParams({ ...Object.fromEntries(seriesQueryToParams(query)), ...extra })
    expect(() => seriesQueryFromParams(params({ metric: 'requests' }))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ type: "input' OR 1=1" }))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ groupBy: 'type' }))).toThrow(BadQueryError)
  })
})

describe('the CloudWatch source asks for one token type', () => {
  it('sends the filtered query and folds account codes into names', async () => {
    const expressions: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const body = JSON.parse(await (input as Request).clone().text()) as {
        MetricDataQueries: Array<{ Expression: string }>
      }
      expressions.push(body.MetricDataQueries[0]?.Expression ?? '')
      const point = (label: string, v: number) => ({
        Id: 'q',
        Label: label,
        Timestamps: [Math.floor(at(10) / 1000)],
        Values: [v],
        StatusCode: 'Complete',
      })
      return Response.json({
        MetricDataResults: [point('alpha', 1000), point('acct-0000aaaa', 500)],
      })
    }) as typeof fetch
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fetchImpl,
      now: () => NOW,
      accountAliases: new Map([['acct-0000aaaa', 'alpha']]),
    })
    const series = await src.series({
      metric: 'tokens',
      groupBy: 'client_account',
      tokenType: 'output',
      range,
      stepSeconds: STEP,
    })
    expect(expressions).toEqual([
      `SELECT SUM("claw_master.inference.tokens.by_client_account") FROM "ClawMaster" WHERE "type" = 'output' GROUP BY client_account`,
    ])
    expect(series).toEqual([{ key: 'alpha', points: [[at(10), 1500]] }])
  })
})

describe('every token type in one query (byType)', () => {
  const query: SeriesQuery = {
    metric: 'tokens',
    groupBy: 'client_account',
    byType: true,
    range,
    stepSeconds: STEP,
  }

  it('groups by the split and the type in one Metrics Insights query', () => {
    expect(
      insightsQuery('ClawMaster', resolveMetric('tokens', 'client_account', undefined, true)),
    ).toBe(
      'SELECT SUM("claw_master.inference.tokens.by_client_account") FROM "ClawMaster" GROUP BY client_account, "type"',
    )
    expect(() => resolveMetric('requests', 'profile', undefined, true)).toThrow(
      UnsupportedQueryError,
    )
  })

  it('round-trips, and is refused without another split, with a type, or on another metric', () => {
    expect(seriesQueryFromParams(seriesQueryToParams(query))).toEqual(query)
    const params = (extra: Record<string, string>, drop?: string) => {
      const p = new URLSearchParams({ ...Object.fromEntries(seriesQueryToParams(query)), ...extra })
      if (drop !== undefined) p.delete(drop)
      return p
    }
    expect(() => seriesQueryFromParams(params({}, 'groupBy'))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ groupBy: 'type' }))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ type: 'input' }))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ metric: 'requests' }))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ byType: 'yes' }))).toThrow(BadQueryError)
  })

  it('folds account codes into names within each type, keyed by group and type', async () => {
    const expressions: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const body = JSON.parse(await (input as Request).clone().text()) as {
        MetricDataQueries: Array<{ Expression: string }>
      }
      expressions.push(body.MetricDataQueries[0]?.Expression ?? '')
      const point = (label: string, v: number) => ({
        Id: 'q',
        Label: label,
        Timestamps: [Math.floor(at(10) / 1000)],
        Values: [v],
        StatusCode: 'Complete',
      })
      return Response.json({
        MetricDataResults: [
          point('alpha output', 1000),
          point('acct-0000aaaa output', 500),
          point('acct-0000aaaa input', 7),
        ],
      })
    }) as typeof fetch
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fetchImpl,
      now: () => NOW,
      accountAliases: new Map([['acct-0000aaaa', 'alpha']]),
    })
    const series = await src.series(query)
    expect(expressions).toHaveLength(1)
    expect(series).toEqual([
      { key: 'alpha output', points: [[at(10), 1500]] },
      { key: 'alpha input', points: [[at(10), 7]] },
    ])
  })

  it('asks one query per type instead when the grouped one comes back at the cap', async () => {
    const expressions: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const body = JSON.parse(await (input as Request).clone().text()) as {
        MetricDataQueries: Array<{ Expression: string }>
      }
      const expression = body.MetricDataQueries[0]?.Expression ?? ''
      expressions.push(expression)
      const point = (label: string) => ({
        Id: 'q',
        Label: label,
        Timestamps: [Math.floor(at(10) / 1000)],
        Values: [1],
        StatusCode: 'Complete',
      })
      // Grouped by type too, the answer is cut at the cap; one type alone fits.
      const labels = expression.includes('GROUP BY project, "type"')
        ? Array.from({ length: MAX_INSIGHTS_SERIES }, (_, i) => `p${i} input`)
        : Array.from({ length: 200 }, (_, i) => `p${i}`)
      return Response.json({ MetricDataResults: labels.map(point) })
    }) as typeof fetch
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fetchImpl,
      now: () => NOW,
    })
    const series = await src.series({ ...query, groupBy: 'project' })
    expect(expressions).toHaveLength(1 + TOKEN_TYPES.length)
    expect(expressions.slice(1).every((e) => e.includes(`WHERE "type" = '`))).toBe(true)
    expect(series).toHaveLength(200 * TOKEN_TYPES.length)
    expect(new Set(series.map((s) => s.key)).size).toBe(series.length)
    expect(tokensOfType(series, 'cache_read')).toHaveLength(200)
  })

  it('gives each type, and all of them summed, as the filtered queries do', async () => {
    const demo = createDemoSource({ now: () => NOW })
    const answer = await demo.series(query)
    const totals = (series: Series[]) =>
      Object.fromEntries(series.map((s) => [s.key, s.points.reduce((sum, [, v]) => sum + v, 0)]))
    for (const tokenType of TOKEN_TYPES) {
      expect(totals(tokensOfType(answer, tokenType))).toEqual(
        totals(await demo.series({ ...query, byType: false, tokenType })),
      )
    }
    const { byType: _, ...all } = query
    expect(totals(tokensOfType(answer, 'all'))).toEqual(totals(await demo.series(all)))
    expect(Object.keys(tokensByType(answer))).toEqual([...TOKEN_TYPES])
  })

  it('splits a group name with spaces at its last space', () => {
    expect(
      tokensOfType(
        [
          { key: 'my project input', points: [[1, 2]] },
          { key: 'my project output', points: [[1, 3]] },
          { key: 'no-type', points: [[1, 9]] },
        ],
        'all',
      ),
    ).toEqual([{ key: 'my project', points: [[1, 5]] }])
  })
})

describe('the demo source counts tokens', () => {
  const demo = createDemoSource({ now: () => NOW })

  it('splits by type, with cache reads the largest, and agrees with each filtered query', async () => {
    const byType = await demo.series({
      metric: 'tokens',
      groupBy: 'type',
      range,
      stepSeconds: STEP,
    })
    expect(byType.map((s) => s.key)).toEqual([...TOKEN_TYPES])
    const totals = Object.fromEntries(
      byType.map((s) => [s.key, s.points.reduce((sum, [, v]) => sum + v, 0)]),
    )
    expect(totals.cache_read).toBeGreaterThan(totals.input as number)
    const input = await demo.series({
      metric: 'tokens',
      tokenType: 'input',
      range,
      stepSeconds: STEP,
    })
    expect(input[0]?.points.reduce((sum, [, v]) => sum + v, 0)).toBe(totals.input)
  })
})

describe('token helpers', () => {
  const series = (key: string, points: Array<[number, number]>): Series => ({ key, points })

  it('finds where the counters start and how much of a range they cover', () => {
    expect(firstPointAt([])).toBeNull()
    expect(firstPointAt([series('a', [[at(30), 1]]), series('b', [[at(50), 1]])])).toBe(at(50))
    expect(tokenCoverage(null, range, STEP)).toBe('none')
    expect(tokenCoverage(range.start, range, STEP)).toBe('full')
    expect(tokenCoverage(range.start + 60_000, range, STEP)).toBe('full')
    expect(tokenCoverage(at(30), range, STEP)).toBe('partial')
  })

  it('drops the buckets before the counters started, never after', () => {
    const filled = [
      series('a', [
        [at(20), 0],
        [at(15), 0],
        [at(10), 7],
        [at(5), 3],
      ]),
    ]
    expect(fromFirstBucket(filled, at(10) + 30_000, STEP)[0]?.points).toEqual([
      [at(10), 7],
      [at(5), 3],
    ])
    expect(fromFirstBucket(filled, null, STEP)).toBe(filled)
  })

  it('makes one row per key across the types, ordered by the chosen total', () => {
    const byType = {
      input: [series('alpha', [[at(10), 10]]), series('bravo', [[at(10), 50]])],
      output: [series('alpha', [[at(10), 20]])],
      cache_read: [series('alpha', [[at(10), 900]])],
      cache_creation: [series('charlie', [[at(10), 5]])],
    }
    const all = tokenRows(byType, 'all')
    expect(all.map((r) => [r.key, r.total])).toEqual([
      ['alpha', 930],
      ['bravo', 50],
      ['charlie', 5],
    ])
    expect(all[0]?.byType).toEqual({ input: 10, output: 20, cache_read: 900, cache_creation: 0 })
    expect(all[0]?.points).toEqual([[at(10), 930]])
    const inputOnly = tokenRows(byType, 'input')
    expect(inputOnly.map((r) => [r.key, r.total])).toEqual([
      ['bravo', 50],
      ['alpha', 10],
      ['charlie', 0],
    ])
    expect(inputOnly[1]?.points).toEqual([[at(10), 10]])
  })

  it('has no row for a key with no tokens of any type in the range', () => {
    const byType = {
      input: [series('alpha', [[at(10), 10]]), series('acct-0', [[at(10), 0]])],
      output: [series('acct-0', []), series('bravo', [[at(10), 4]])],
    }
    expect(tokenRows(byType, 'all').map((r) => r.key)).toEqual(['alpha', 'bravo'])
    // A row with other types' tokens stays, at 0, when one type is chosen.
    expect(tokenRows(byType, 'input').map((r) => [r.key, r.total])).toEqual([
      ['alpha', 10],
      ['bravo', 0],
    ])
  })

  it('has no request row for a key with no requests in the range', () => {
    expect(
      requestTable([
        series('alpha', [[at(10), 3]]),
        series('acct-0', [[at(10), 0]]),
        series('bravo', [[at(10), 5]]),
      ]).map((r) => [r.key, r.total]),
    ).toEqual([
      ['bravo', 5],
      ['alpha', 3],
    ])
  })

  it("names the table's range from when token counts start, when that is partway through", () => {
    const clock = () => '02:15'
    expect(tableRangeWords('partial', NOW - HOUR_MS, 'last 7 days', clock)).toBe('since 02:15')
    expect(tableRangeWords('partial', NOW - HOUR_MS, 'last 7 days', null)).toBe(
      'since token counting began',
    )
    expect(tableRangeWords('full', NOW - HOUR_MS, 'last 7 days', clock)).toBe('last 7 days')
    expect(tableRangeWords(null, NOW - HOUR_MS, 'last 7 days', clock)).toBe('last 7 days')
  })

  it('sums each type over a window from a query split by type', () => {
    const byType = [
      series('input', [
        [at(70), 1],
        [at(30), 2],
      ]),
      series('cache_read', [[at(30), 40]]),
      series('unknown', [[at(30), 99]]),
    ]
    expect(tokensBetween(byType, at(60), NOW)).toEqual({
      input: 2,
      output: 0,
      cache_read: 40,
      cache_creation: 0,
    })
  })
})

describe("the page's token queries", () => {
  it('asks for every token type in one query per split and range, never one per type', () => {
    const tabs = tabQueries(NOW, '24h')
    const first = firstQueries(NOW)
    for (const q of [...tabs, ...first]) {
      expect(q.tokenType, queryKey(q)).toBeUndefined()
      if (q.metric === 'tokens' && q.groupBy !== 'type') expect(q.byType, queryKey(q)).toBe(true)
    }
    // Each asked once: per range, requests, tokens, errors and weekly use by subscription, then
    // the table's splits (requests and tokens by person and machine, tokens by project, requests
    // by model; by subscription is the chart's own).
    expect(new Set(tabs.map(queryKey)).size).toBe(tabs.length)
    expect(tabs).toHaveLength(20)
    expect(new Set(first.map(queryKey)).size).toBe(first.length)
  })
})
