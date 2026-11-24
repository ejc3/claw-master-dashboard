import type { Dimension, SemanticMetric, TokenType } from './types'

/** How a stored series is reduced: counters arrive as deltas (sum), gauges as levels. */
export type Statistic = 'SUM' | 'AVG' | 'MAX' | 'MIN'

/** A semantic query resolved to the metric claude-master actually emits. */
export interface ResolvedMetric {
  /** The OpenTelemetry metric name, which CloudWatch keeps as the metric name. */
  name: string
  statistic: Statistic
  groupBy?: Dimension
  /** Only points of this token type (tokens only). */
  tokenType?: TokenType
  /** Split by token type as well as by groupBy (tokens only). */
  byType?: boolean
  /**
   * Split by rate as well (premium tokens, always): each series is keyed "<group> <type>@<rate>",
   * so the rate rides with the type wherever a key is split at its last space.
   */
  byRate?: boolean
}

interface Entry {
  name: string
  statistic: Statistic
  /** The dimensions this metric carries; grouping by any other one is refused. */
  dimensions: readonly Dimension[]
  /** A sibling metric that carries a dimension this one does not (one projection per axis). */
  projections?: Partial<Record<Dimension, string>>
  /** Split by type and by `rate` too, always (premiumTokens). */
  byRate?: true
}

// claude-master never crosses its axes: each metric carries at most three attributes, and a
// split by another axis is a separate metric (docs/claw-master.md in ejc3/CLIProxyAPI).
const CATALOG: Record<SemanticMetric, Entry> = {
  requests: {
    name: 'claw_master.inference.requests',
    statistic: 'SUM',
    dimensions: ['profile', 'client_account', 'status_class'],
    projections: {
      client: 'claw_master.inference.requests.by_client',
      model: 'claw_master.inference.requests.by_model',
    },
  },
  errors: {
    name: 'claw_master.inference.errors',
    statistic: 'SUM',
    dimensions: ['profile', 'status', 'client_account'],
  },
  switches: {
    name: 'claw_master.routing.switches',
    statistic: 'SUM',
    dimensions: ['reason', 'from', 'to'],
  },
  rateLimited: {
    name: 'claw_master.quota.rate_limited',
    statistic: 'SUM',
    dimensions: ['profile'],
  },
  backupRequests: {
    name: 'claw_master.routing.backup_requests',
    statistic: 'SUM',
    dimensions: [],
  },
  ttfbMs: {
    name: 'claw_master.inference.ttfb',
    statistic: 'AVG',
    dimensions: ['profile', 'status_class'],
    projections: { model: 'claw_master.inference.ttfb.by_model' },
  },
  durationMs: {
    name: 'claw_master.inference.duration',
    statistic: 'AVG',
    dimensions: ['profile', 'status_class'],
    projections: { model: 'claw_master.inference.duration.by_model' },
  },
  upstreamTtfbMs: {
    name: 'claw_master.inference.upstream_ttfb',
    statistic: 'AVG',
    dimensions: ['profile', 'status_class'],
  },
  overheadMs: { name: 'claw_master.proxy.overhead', statistic: 'AVG', dimensions: ['profile'] },
  quotaBand: { name: 'claw_master.quota.band', statistic: 'MAX', dimensions: ['profile'] },
  weeklyUsed: {
    name: 'claw_master.quota.used_fraction',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  // The usage poll's 5-hour window, as the weekly one: with both, what a full window costs of the
  // week can be measured (weekPerFiveHourWindow).
  fiveHourUsed: {
    name: 'claw_master.quota.five_hour.used_fraction',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  weeklyResetsInSeconds: {
    name: 'claw_master.quota.resets_in_seconds',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  // The usage poll's countdown to the 5-hour window's reset, reported while a window is open.
  fiveHourResetsInSeconds: {
    name: 'claw_master.quota.five_hour.resets_in_seconds',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  // The weekly Fable allowance's used share and countdown (ejc3/CLIProxyAPI#34): an early reset of
  // the allowance is measured from them (earlyResets).
  fableUsed: {
    name: 'claw_master.quota.fable.used_fraction',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  fableResetsInSeconds: {
    name: 'claw_master.quota.fable.resets_in_seconds',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  tokenExpiresInSeconds: {
    name: 'claw_master.auth.token_expires_in_seconds',
    statistic: 'MIN',
    dimensions: ['profile'],
  },
  // Read from the usage in each response; every projection also carries the token type.
  tokens: {
    name: 'claw_master.inference.tokens',
    statistic: 'SUM',
    dimensions: ['profile', 'type'],
    projections: {
      client_account: 'claw_master.inference.tokens.by_client_account',
      client: 'claw_master.inference.tokens.by_client',
      // The project a launch was started in (claude-master releases that count it).
      project: 'claw_master.inference.tokens.by_project',
      // The request's model (claw-master releases that count it).
      model: 'claw_master.inference.tokens.by_model',
    },
  },
  // The tokens the API bills above its standard rate, also counted in tokens: by rate, "1h"
  // (hour-long cache writes), "fast" (a fast-mode request's) or "fast_1h" (both), so they can be
  // priced (core/apiCost). Only by person and by model, and always by type and rate.
  premiumTokens: {
    name: 'claw_master.inference.premium_tokens.by_client_account',
    statistic: 'SUM',
    dimensions: ['client_account'],
    projections: { model: 'claw_master.inference.premium_tokens.by_model' },
    byRate: true,
  },
}

const DIMENSIONS: readonly Dimension[] = [
  'profile',
  'client',
  'client_account',
  'project',
  'model',
  'status_class',
  'status',
  'reason',
  'from',
  'to',
  'result',
  'type',
]

export class UnsupportedQueryError extends Error {
  constructor(metric: SemanticMetric, groupBy: Dimension) {
    super(`claw-master does not emit ${metric} split by ${groupBy}`)
    this.name = 'UnsupportedQueryError'
  }
}

/**
 * Resolves a semantic metric (optionally split by one dimension, and for tokens optionally one
 * token type) to the emitted metric.
 */
export function resolveMetric(
  metric: SemanticMetric,
  groupBy?: Dimension,
  tokenType?: TokenType,
  byType?: boolean,
): ResolvedMetric {
  const entry = CATALOG[metric]
  if (metric === 'premiumTokens' && (groupBy === undefined || byType !== true)) {
    throw new UnsupportedQueryError(metric, groupBy ?? 'type')
  }
  if (tokenType !== undefined && metric !== 'tokens') {
    throw new UnsupportedQueryError(metric, 'type')
  }
  if (byType === true && metric !== 'tokens' && metric !== 'premiumTokens') {
    throw new UnsupportedQueryError(metric, 'type')
  }
  const typed = {
    ...(tokenType === undefined ? {} : { tokenType }),
    ...(byType === true ? { byType } : {}),
    ...(entry.byRate === true ? { byRate: true } : {}),
  }
  if (groupBy === undefined) return { name: entry.name, statistic: entry.statistic, ...typed }
  if (entry.dimensions.includes(groupBy)) {
    return { name: entry.name, statistic: entry.statistic, groupBy, ...typed }
  }
  const projection = entry.projections?.[groupBy]
  if (projection !== undefined) {
    return { name: projection, statistic: entry.statistic, groupBy, ...typed }
  }
  throw new UnsupportedQueryError(metric, groupBy)
}

/** The dimensions a semantic metric can be split by. */
export function groupableBy(metric: SemanticMetric): Dimension[] {
  const entry = CATALOG[metric]
  return DIMENSIONS.filter(
    (d) => entry.dimensions.includes(d) || entry.projections?.[d] !== undefined,
  )
}

// Metrics Insights keywords that must be quoted when used as a dimension name. `type` is quoted
// too: quoting is harmless, and it keeps the token filter safe from the keyword list growing.
const RESERVED = new Set<string>(['result', 'window', 'from', 'to', 'type', 'rate'])

function identifier(name: string): string {
  return RESERVED.has(name) ? `"${name}"` : name
}

/**
 * The CloudWatch Metrics Insights query for a resolved metric in a namespace. A namespace that
 * would need escaping inside the query's quotes is refused rather than escaped.
 */
export function insightsQuery(namespace: string, resolved: ResolvedMetric): string {
  if (!/^[A-Za-z0-9 ._\-/#:]{1,255}$/.test(namespace)) {
    throw new Error('the namespace must be 1-255 letters, digits or . _ - / # : and spaces')
  }
  const groups = [
    ...(resolved.groupBy === undefined ? [] : [identifier(resolved.groupBy)]),
    ...(resolved.byType === true ? [identifier('type')] : []),
    ...(resolved.byRate === true ? [identifier('rate')] : []),
  ]
  const group = groups.length === 0 ? '' : ` GROUP BY ${groups.join(', ')}`
  // The token type is one of four fixed words (checked where the query is parsed), so it is
  // written into the query as it is.
  const where =
    resolved.tokenType === undefined ? '' : ` WHERE ${identifier('type')} = '${resolved.tokenType}'`
  return `SELECT ${resolved.statistic}("${resolved.name}") FROM "${namespace}"${where}${group}`
}
