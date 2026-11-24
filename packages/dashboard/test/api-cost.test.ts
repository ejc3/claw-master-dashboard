import { describe, expect, it } from 'vitest'
import { apiCost, apiPriceOf, formatDollars, HOUR_MS, type Series } from '../src/core/index'
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
