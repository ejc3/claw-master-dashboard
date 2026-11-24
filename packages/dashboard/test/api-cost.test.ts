import { describe, expect, it } from 'vitest'
import { createCloudWatchSource } from '../src/cloudwatch/index'
import {
  apiCost,
  apiPriceOf,
  formatDollars,
  HOUR_MS,
  insightsQuery,
  premiumExtra,
  resolveMetric,
  type Series,
  seriesQueryFromParams,
} from '../src/core/index'
import { keptAnswer } from '../src/react/Breakdown'
import { breakdownQueries, COST_STEP_SECONDS, SPLITS } from '../src/react/queries'

const T0 = Date.UTC(2026, 10, 23, 12)
const STEP = 600_000
const at = (i: number) => T0 + i * STEP
const OPUS = 'claude-opus-5-5' // $4 in, $20 out, $0.20 cache read, $5 cache write per million
const SONNET = 'claude-sonnet-5-5' // $2 in, $10 out

/** A "<group> <type>" series from [step, tokens] pairs. */
const s = (key: string, points: Array<[number, number]>): Series => ({
  key,
  points: points.map(([i, v]) => [at(i), v]),
})

describe('API prices', () => {
  it('names a model by its alias, dated or as a platform names it', () => {
    expect(apiPriceOf(OPUS)?.output).toBe(20)
    expect(apiPriceOf('claude-haiku-4-5-20251001')?.input).toBe(1)
    expect(apiPriceOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0')?.input).toBe(3)
    expect(apiPriceOf('global.anthropic.claude-opus-4-8')?.cache_read).toBe(0.5)
    expect(apiPriceOf('claude-test-model')).toBeNull()
  })

  it('writes dollars to the cent, whole dollars from $100', () => {
    expect(formatDollars(null)).toBe('—')
    expect(formatDollars(0)).toBe('$0')
    expect(formatDollars(0.004)).toBe('<$0.01')
    expect(formatDollars(0.42)).toBe('$0.42')
    expect(formatDollars(38.2)).toBe('$38.20')
    expect(formatDollars(1240.4)).toBe('$1,240')
    expect(formatDollars(99.996)).toBe('$100')
  })
})

describe('API cost', () => {
  it('prices each type at its model and gives one person all of a step they worked alone', () => {
    const cost = apiCost(
      [
        s('alice input', [[0, 1e6]]),
        s('alice output', [[0, 1e6]]),
        s('alice cache_read', [[0, 1e6]]),
      ],
      [
        s(`${OPUS} input`, [[0, 1e6]]),
        s(`${OPUS} output`, [[0, 1e6]]),
        s(`${OPUS} cache_read`, [[0, 1e6]]),
      ],
      [s(OPUS, [[0, 10]])],
    )
    expect(cost?.total).toBeCloseTo(24.2)
    expect(cost?.people.get('alice')).toBeCloseTo(24.2)
    expect(cost?.models.get(OPUS)).toBeCloseTo(24.2)
    expect(cost?.estimatedUntil).toBeNull()
  })

  it("shares a step's cost of each type by the people's tokens of that type", () => {
    // One step: Opus and Sonnet output, half each; alice wrote 3/4 of the output, bob 1/4.
    const cost = apiCost(
      [s('alice output', [[0, 3e6]]), s('bob output', [[0, 1e6]]), s('bob input', [[0, 1e6]])],
      [
        s(`${OPUS} output`, [[0, 2e6]]),
        s(`${SONNET} output`, [[0, 2e6]]),
        s(`${SONNET} input`, [[0, 1e6]]),
      ],
      [s(OPUS, [[0, 1]]), s(SONNET, [[0, 1]])],
    )
    // Output: 2M at $20 + 2M at $10 = $60, 3:1. Input: 1M at $2, all bob's.
    expect(cost?.people.get('alice')).toBeCloseTo(45)
    expect(cost?.people.get('bob')).toBeCloseTo(17)
    expect(cost?.models.get(OPUS)).toBeCloseTo(40)
    expect(cost?.models.get(SONNET)).toBeCloseTo(22)
    expect(cost?.total).toBeCloseTo(62)
  })

  it('estimates the model mix from requests before tokens by model were counted', () => {
    // Steps 2-3 count tokens by model: Opus 1M output per request, Sonnet 0.5M.
    const people = [
      s('alice output', [
        [0, 3e6],
        [2, 1e6],
        [3, 1e6],
      ]),
    ]
    const models = [s(`${OPUS} output`, [[2, 1e6]]), s(`${SONNET} output`, [[3, 1e6]])]
    const requests = [
      s(OPUS, [
        [0, 1],
        [2, 1],
      ]),
      s(SONNET, [
        [0, 2],
        [3, 2],
      ]),
    ]
    const cost = apiCost(people, models, requests)
    // Step 0: 1 Opus request (1M) and 2 Sonnet (0.5M each): 3M output, half each, $30 + $15.
    expect(cost?.models.get(OPUS)).toBeCloseTo(30 + 20)
    expect(cost?.models.get(SONNET)).toBeCloseTo(15 + 10)
    expect(cost?.people.get('alice')).toBeCloseTo(75)
    expect(cost?.estimatedUntil).toBe(at(2))
  })

  it('leaves out a model the list does not price, and needs tokens by model to price anything', () => {
    const cost = apiCost(
      [s('alice output', [[0, 2e6]])],
      [s(`${OPUS} output`, [[0, 1e6]]), s('claude-test-model output', [[0, 1e6]])],
      [s(OPUS, [[0, 1]]), s('claude-test-model', [[0, 1]])],
    )
    expect(cost?.total).toBeCloseTo(20)
    expect(cost?.models.has('claude-test-model')).toBe(false)
    expect(apiCost([s('alice output', [[0, 1e6]])], [], [s(OPUS, [[0, 1]])])).toBeNull()
    expect(apiCost([], [s(`${OPUS} output`, [[0, 0]])], [])).toBeNull()
  })

  it('works from ten-minute steps at most, by person and by model, for people and models only', () => {
    const range = { start: T0, end: T0 + 7 * 24 * HOUR_MS }
    const people = SPLITS.find((x) => x.dimension === 'client_account')
    const machines = SPLITS.find((x) => x.dimension === 'client')
    if (people === undefined || machines === undefined) throw new Error('no split')
    const week = breakdownQueries(range, 3600, people).cost
    expect(week?.people).toMatchObject({
      metric: 'tokens',
      groupBy: 'client_account',
      byType: true,
    })
    expect(week?.models).toMatchObject({ metric: 'tokens', groupBy: 'model', byType: true })
    expect(week?.requests).toMatchObject({ metric: 'requests', groupBy: 'model' })
    expect(week?.people.stepSeconds).toBe(COST_STEP_SECONDS)
    expect(breakdownQueries(range, 300, people).cost?.models.stepSeconds).toBe(300)
    expect(breakdownQueries(range, 300, machines).cost).toBeNull()
  })
})

describe('the cost kept while its next answer loads', () => {
  const HOUR = 3600_000
  const range = { start: T0, end: T0 + 7 * 24 * HOUR }
  const people = SPLITS.find((x) => x.dimension === 'client_account')
  if (people === undefined) throw new Error('no People split')
  const query = (end: number) =>
    breakdownQueries({ start: range.start + end, end: range.end + end }, 3600, people).cost
      ?.people ?? null
  const data: Series[] = [s('alice output', [[0, 1]])]
  const ready = { state: 'ready', data, at: T0, failure: null } as const

  it('keeps it while loading and the range moved at most a step, and only then', () => {
    const first = keptAnswer(null, ready, query(0), HOUR)
    expect(first.show).toBe(data)
    const loading = { state: 'loading' } as const
    expect(keptAnswer(first.kept, loading, query(HOUR), HOUR).show).toBe(data)
    // Hours later (a page left hidden): not kept.
    expect(keptAnswer(first.kept, loading, query(3 * HOUR), HOUR).show).toBeNull()
    // A failed query shows nothing, not the old figure.
    const failed = { state: 'error', failure: { message: 'no', status: 500 } } as never
    expect(keptAnswer(first.kept, failed, query(HOUR), HOUR).show).toBeNull()
    // Another range's answer never shows under this one.
    const day = breakdownQueries(range, 300, people).cost?.people ?? null
    expect(keptAnswer(first.kept, loading, day, HOUR).show).toBeNull()
  })
})

describe('tokens billed above the standard rate', () => {
  it('cost their extra over the standard rate, by rate', () => {
    const opus = apiPriceOf(OPUS)
    const sonnet = apiPriceOf(SONNET)
    if (opus === null || sonnet === null) throw new Error('no price')
    expect(premiumExtra(opus, 'cache_creation', '1h')).toBe(3) // $8 against $5
    expect(premiumExtra(opus, 'output', '1h')).toBe(0)
    expect(premiumExtra(opus, 'output', 'fast')).toBe(20) // $40 against $20
    expect(premiumExtra(opus, 'cache_creation', 'fast')).toBe(5) // $10 against $5
    expect(premiumExtra(opus, 'cache_creation', 'fast_1h')).toBe(11) // $16 against $5
    // No fast mode on Sonnet 5.5: a fast request's tokens cost the standard rate, its hour-long
    // writes the hour-long rate.
    expect(premiumExtra(sonnet, 'output', 'fast')).toBe(0)
    expect(premiumExtra(sonnet, 'cache_creation', 'fast_1h')).toBe(1.5)
    expect(premiumExtra(opus, 'input', 'something-new')).toBe(0)
  })

  it("add each model's extra and share it by the people's premium tokens of that type and rate", () => {
    const cost = apiCost(
      [
        s('alice cache_creation', [[0, 1e6]]),
        s('alice output', [[0, 1e6]]),
        s('bob output', [[0, 1e6]]),
      ],
      [s(`${OPUS} cache_creation`, [[0, 1e6]]), s(`${OPUS} output`, [[0, 2e6]])],
      [s(OPUS, [[0, 2]])],
      {
        // Alice's writes were kept an hour; bob's request was fast.
        people: [s('alice cache_creation@1h', [[0, 1e6]]), s('bob output@fast', [[0, 1e6]])],
        models: [s(`${OPUS} cache_creation@1h`, [[0, 1e6]]), s(`${OPUS} output@fast`, [[0, 1e6]])],
      },
    )
    // Standard: alice $5 writes + $20 output, bob $20 output. Extra: alice $3, bob $20.
    expect(cost?.people.get('alice')).toBeCloseTo(28)
    expect(cost?.people.get('bob')).toBeCloseTo(40)
    expect(cost?.models.get(OPUS)).toBeCloseTo(68)
    expect(cost?.total).toBeCloseTo(68)
  })

  it('are asked for by person or model, type and rate, and keyed with the rate on the type', () => {
    expect(
      insightsQuery('ClawMaster', resolveMetric('premiumTokens', 'model', undefined, true)),
    ).toBe(
      'SELECT SUM("claw_master.inference.premium_tokens.by_model") FROM "ClawMaster" GROUP BY model, "type", "rate"',
    )
    expect(() => resolveMetric('premiumTokens', 'profile', undefined, true)).toThrow()
    expect(() => resolveMetric('premiumTokens', 'client_account')).toThrow()
    const params = new URLSearchParams({
      metric: 'premiumTokens',
      groupBy: 'model',
      start: '0',
      end: '600000',
      step: '600',
    })
    expect(() => seriesQueryFromParams(params)).toThrow()
    params.set('byType', '1')
    expect(seriesQueryFromParams(params).byType).toBe(true)
  })
})

describe('premium tokens from CloudWatch', () => {
  it('key each series "<group> <type>@<rate>", folding people under their names', async () => {
    const fetchImpl = (async () =>
      Response.json({
        MetricDataResults: ['uuid-1 cache_creation 1h', 'alice output fast'].map((label) => ({
          Id: 'q',
          Label: label,
          Timestamps: [Math.floor(T0 / 1000)],
          Values: [5],
          StatusCode: 'Complete',
        })),
      })) as typeof fetch
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fetchImpl,
      now: () => T0 + HOUR_MS,
      accountAliases: new Map([['uuid-1', 'alice']]),
    })
    const series = await src.series({
      metric: 'premiumTokens',
      groupBy: 'client_account',
      byType: true,
      range: { start: T0, end: T0 + HOUR_MS },
      stepSeconds: 600,
    })
    expect(series.map((x) => x.key).sort()).toEqual([
      'alice cache_creation@1h',
      'alice output@fast',
    ])
  })
})
