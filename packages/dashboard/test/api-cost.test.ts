import { describe, expect, it } from 'vitest'
import {
  formatDollars,
  HOUR_MS,
  insightsQuery,
  resolveMetric,
  type Series,
} from '../src/core/index'
import { costSummary } from '../src/react/Breakdown'

const START = Date.UTC(2026, 10, 23, 12)
const RANGE = { start: START, end: START + 24 * HOUR_MS }
const STEP = 300

describe('API cost', () => {
  it('reads the cost counters by person and by model, and nothing else', () => {
    expect(insightsQuery('ClawMaster', resolveMetric('apiCost', 'client_account'))).toBe(
      'SELECT SUM("claw_master.inference.api_cost.by_client_account") FROM "ClawMaster" GROUP BY client_account',
    )
    expect(resolveMetric('apiCost', 'model').name).toBe('claw_master.inference.api_cost.by_model')
    expect(() => resolveMetric('apiCost', 'profile')).toThrow()
  })

  it('writes dollars to the cent, whole dollars from $100', () => {
    expect(formatDollars(null)).toBe('—')
    expect(formatDollars(0)).toBe('$0')
    expect(formatDollars(0.004)).toBe('<$0.01')
    expect(formatDollars(0.42)).toBe('$0.42')
    expect(formatDollars(38.2)).toBe('$38.20')
    expect(formatDollars(1240.4)).toBe('$1,240')
  })

  it('sums each key over the range and says from when, if counted after the tokens began', () => {
    const series: Series[] = [
      {
        key: 'alice',
        points: [
          [START, 1.5],
          [START + HOUR_MS, 2],
        ],
      },
      { key: 'bob', points: [[START + HOUR_MS, 0.25]] },
      { key: 'idle', points: [[START, 0]] },
    ]
    const later = START + 2 * HOUR_MS
    const both = costSummary(series, START, START, RANGE, STEP)
    expect(both && [...both.byKey]).toEqual([
      ['alice', 3.5],
      ['bob', 0.25],
    ])
    expect(both?.total).toBe(3.75)
    expect(both?.from).toBeNull()
    // Priced only from a later release: the total says from when.
    expect(costSummary(series, later, START, RANGE, STEP)?.from).toBe(later)
    // Tokens and cost both started late, in the same bucket: nothing to add.
    expect(costSummary(series, later + 60_000, later, RANGE, STEP)?.from).toBeNull()
    // Nothing priced yet: no column, no total.
    expect(costSummary([], null, START, RANGE, STEP)).toBeNull()
    expect(costSummary(null, null, START, RANGE, STEP)).toBeNull()
    expect(
      costSummary([{ key: 'idle', points: [[START, 0]] }], START, START, RANGE, STEP),
    ).toBeNull()
  })
})
