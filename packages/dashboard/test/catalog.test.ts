import { describe, expect, it } from 'vitest'
import {
  type Dimension,
  groupableBy,
  insightsQuery,
  resolveMetric,
  type SemanticMetric,
  UnsupportedQueryError,
} from '../src/core/index'

// Queries that were checked against the live CloudWatch API for the claude-master server's own
// CloudWatch dashboard. The catalog must produce them exactly.
const GOLDEN: Array<[SemanticMetric, Dimension | undefined, string]> = [
  [
    'requests',
    'client_account',
    'SELECT SUM("claw_master.inference.requests") FROM "ClawMaster" GROUP BY client_account',
  ],
  [
    'requests',
    'profile',
    'SELECT SUM("claw_master.inference.requests") FROM "ClawMaster" GROUP BY profile',
  ],
  [
    'requests',
    'client',
    'SELECT SUM("claw_master.inference.requests.by_client") FROM "ClawMaster" GROUP BY client',
  ],
  [
    'requests',
    'model',
    'SELECT SUM("claw_master.inference.requests.by_model") FROM "ClawMaster" GROUP BY model',
  ],
  [
    'requests',
    'status_class',
    'SELECT SUM("claw_master.inference.requests") FROM "ClawMaster" GROUP BY status_class',
  ],
  [
    'errors',
    'status',
    'SELECT SUM("claw_master.inference.errors") FROM "ClawMaster" GROUP BY status',
  ],
  [
    'ttfbMs',
    'profile',
    'SELECT AVG("claw_master.inference.ttfb") FROM "ClawMaster" GROUP BY profile',
  ],
  [
    'durationMs',
    'model',
    'SELECT AVG("claw_master.inference.duration.by_model") FROM "ClawMaster" GROUP BY model',
  ],
  [
    'upstreamTtfbMs',
    undefined,
    'SELECT AVG("claw_master.inference.upstream_ttfb") FROM "ClawMaster"',
  ],
  ['overheadMs', undefined, 'SELECT AVG("claw_master.proxy.overhead") FROM "ClawMaster"'],
  [
    'weeklyUsed',
    'profile',
    'SELECT MAX("claw_master.quota.used_fraction") FROM "ClawMaster" GROUP BY profile',
  ],
  [
    'fiveHourUsed',
    'profile',
    'SELECT MAX("claw_master.quota.five_hour.used_fraction") FROM "ClawMaster" GROUP BY profile',
  ],
  [
    'weeklyResetsInSeconds',
    'profile',
    'SELECT MAX("claw_master.quota.resets_in_seconds") FROM "ClawMaster" GROUP BY profile',
  ],
  [
    'switches',
    'reason',
    'SELECT SUM("claw_master.routing.switches") FROM "ClawMaster" GROUP BY reason',
  ],
  ['rateLimited', undefined, 'SELECT SUM("claw_master.quota.rate_limited") FROM "ClawMaster"'],
  [
    'backupRequests',
    undefined,
    'SELECT SUM("claw_master.routing.backup_requests") FROM "ClawMaster"',
  ],
  [
    'tokenExpiresInSeconds',
    'profile',
    'SELECT MIN("claw_master.auth.token_expires_in_seconds") FROM "ClawMaster" GROUP BY profile',
  ],
]

describe('catalog', () => {
  it.each(GOLDEN)('%s by %s matches the live-checked query', (metric, groupBy, query) => {
    expect(insightsQuery('ClawMaster', resolveMetric(metric, groupBy))).toBe(query)
  })

  it('quotes Metrics Insights keywords used as dimension names', () => {
    const resolved = {
      name: 'claw_master.auth.refresh',
      statistic: 'SUM' as const,
      groupBy: 'result' as const,
    }
    expect(insightsQuery('ClawMaster', resolved)).toBe(
      'SELECT SUM("claw_master.auth.refresh") FROM "ClawMaster" GROUP BY "result"',
    )
  })

  it('refuses a split claude-master does not emit instead of returning nothing', () => {
    expect(() => resolveMetric('errors', 'model')).toThrow(UnsupportedQueryError)
    expect(() => resolveMetric('errors', 'client')).toThrow('does not emit errors split by client')
    expect(() => resolveMetric('backupRequests', 'profile')).toThrow(UnsupportedQueryError)
  })

  it('lists the splits it accepts', () => {
    expect(groupableBy('requests').sort()).toEqual(
      ['client', 'client_account', 'model', 'profile', 'status_class'].sort(),
    )
    expect(groupableBy('switches').sort()).toEqual(['from', 'reason', 'to'])
  })
})
