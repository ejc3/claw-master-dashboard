import { describe, expect, it } from 'vitest'
import {
  type Dimension,
  insightsQuery,
  resolveMetric,
  type SemanticMetric,
  UnsupportedQueryError,
} from '../src/core/index'

// The attributes each metric carries, written out from claude-master's metrics.go
// (internal/clawmaster/metrics.go, observeRequest and the routing/quota recorders), not from
// the catalog: a catalog change that accepts a split the proxy does not emit fails here.
const EMITTED: Record<string, readonly Dimension[]> = {
  'claw_master.inference.requests': ['profile', 'client_account', 'status_class'],
  'claw_master.inference.requests.by_client': ['client', 'client_account'],
  'claw_master.inference.requests.by_model': ['model', 'status_class'],
  'claw_master.inference.errors': ['profile', 'status', 'client_account'],
  'claw_master.routing.switches': ['from', 'to', 'reason'],
  'claw_master.quota.rate_limited': ['profile'],
  'claw_master.routing.backup_requests': [],
  'claw_master.inference.ttfb': ['profile', 'status_class'],
  'claw_master.inference.ttfb.by_model': ['model'],
  'claw_master.inference.duration': ['profile', 'status_class'],
  'claw_master.inference.duration.by_model': ['model'],
  'claw_master.inference.upstream_ttfb': ['profile', 'status_class'],
  'claw_master.proxy.overhead': ['profile'],
  'claw_master.quota.used_fraction': ['profile'],
  'claw_master.quota.resets_in_seconds': ['profile'],
  'claw_master.quota.five_hour.used_fraction': ['profile'],
  'claw_master.auth.token_expires_in_seconds': ['profile'],
  // tokens.go (CLIProxyAPI#14): one projection per axis, each with the token type.
  'claw_master.inference.tokens': ['profile', 'type'],
  'claw_master.inference.tokens.by_client_account': ['client_account', 'type'],
  'claw_master.inference.tokens.by_client': ['client', 'type'],
}

const METRICS: SemanticMetric[] = [
  'requests',
  'errors',
  'switches',
  'rateLimited',
  'backupRequests',
  'ttfbMs',
  'durationMs',
  'upstreamTtfbMs',
  'overheadMs',
  'weeklyUsed',
  'fiveHourUsed',
  'weeklyResetsInSeconds',
  'tokenExpiresInSeconds',
  'tokens',
]
const DIMENSIONS: Dimension[] = [
  'profile',
  'client',
  'client_account',
  'model',
  'status_class',
  'status',
  'reason',
  'from',
  'to',
  'result',
  'type',
]

describe('catalog against what claude-master emits', () => {
  for (const metric of METRICS) {
    it(`${metric}: the total and every split resolve to an emitted metric carrying that split`, () => {
      const total = resolveMetric(metric)
      expect(EMITTED[total.name]).toBeDefined()
      for (const dimension of DIMENSIONS) {
        // Some emitted metric of this family carries the split: the catalog must offer it.
        let resolved: ReturnType<typeof resolveMetric> | null = null
        try {
          resolved = resolveMetric(metric, dimension)
        } catch (error) {
          expect(error).toBeInstanceOf(UnsupportedQueryError)
        }
        if (resolved !== null) {
          expect(EMITTED[resolved.name], `${resolved.name} is not emitted`).toContain(dimension)
          expect(resolved.statistic).toBe(total.statistic)
        } else {
          expect(EMITTED[total.name]).not.toContain(dimension)
        }
      }
    })
  }

  it('refuses a namespace that would need escaping inside the query', () => {
    expect(() => insightsQuery('Demo"Metrics', resolveMetric('requests'))).toThrow()
    expect(() => insightsQuery('', resolveMetric('requests'))).toThrow()
    expect(insightsQuery('Team/Claude-Master_1', resolveMetric('requests'))).toBe(
      'SELECT SUM("claw_master.inference.requests") FROM "Team/Claude-Master_1"',
    )
  })

  it('quotes from and to, which are query keywords', () => {
    expect(insightsQuery('ClawMaster', resolveMetric('switches', 'from'))).toBe(
      'SELECT SUM("claw_master.routing.switches") FROM "ClawMaster" GROUP BY "from"',
    )
  })
})
