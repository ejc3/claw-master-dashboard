import { type EpochMs, type Series, type TimeRange, TOKEN_TYPES, type TokenType } from './types'

/** The token types as the page names them: claude-master's `cache_creation` is a cache write. */
export const TOKEN_LABELS: Record<TokenType, string> = {
  input: 'Input',
  output: 'Output',
  cache_read: 'Cache read',
  cache_creation: 'Cache write',
}

/** What the type control selects: one kind of token, or all four summed. */
export type TokenChoice = 'all' | TokenType

export const TOKEN_CHOICES: readonly TokenChoice[] = ['all', ...TOKEN_TYPES]

export function tokenChoiceLabel(choice: TokenChoice): string {
  return choice === 'all' ? 'All tokens' : TOKEN_LABELS[choice]
}

/** The time of the earliest point any series has; null when there are none. */
export function firstPointAt(series: readonly Series[]): EpochMs | null {
  let first: EpochMs | null = null
  for (const s of series) {
    for (const [t] of s.points) if (first === null || t < first) first = t
  }
  return first
}

/**
 * How much of a range the token counters cover, from the earliest raw point: none (no point at
 * all: before the release that counts tokens, or no traffic), partial (they start inside the
 * range) or full. A point in the range's first bucket counts as full.
 */
export function tokenCoverage(
  firstAt: EpochMs | null,
  range: TimeRange,
  stepSeconds: number,
): 'none' | 'partial' | 'full' {
  if (firstAt === null) return 'none'
  return firstAt >= range.start + stepSeconds * 1000 ? 'partial' : 'full'
}

/**
 * One token choice from a query split by type (byType: keys "<group> <type>"): that type's lines
 * under their groups' names, or for 'all' each group's types summed at each time. Groups keep the
 * order they first appear in.
 */
export function tokensOfType(series: readonly Series[], choice: TokenChoice): Series[] {
  const groups = new Map<string, Map<EpochMs, number>>()
  for (const s of series) {
    const at = s.key.lastIndexOf(' ')
    if (at < 0) continue
    const type = s.key.slice(at + 1)
    if (!(TOKEN_TYPES as readonly string[]).includes(type)) continue
    if (choice !== 'all' && type !== choice) continue
    const group = s.key.slice(0, at)
    let sums = groups.get(group)
    if (sums === undefined) {
      sums = new Map()
      groups.set(group, sums)
    }
    for (const [t, v] of s.points) sums.set(t, (sums.get(t) ?? 0) + v)
  }
  return [...groups].map(([key, sums]) => ({
    key,
    points: [...sums].sort((a, b) => a[0] - b[0]),
  }))
}

/** Every type's lines from a query split by type, under their groups' names. */
export function tokensByType(series: readonly Series[]): Record<TokenType, Series[]> {
  return Object.fromEntries(TOKEN_TYPES.map((t) => [t, tokensOfType(series, t)])) as Record<
    TokenType,
    Series[]
  >
}

/**
 * Drops the buckets before the counters started, so a range that begins before the release
 * does not show zeros for time nobody counted. Series are on the step grid (see fillSeries).
 */
export function fromFirstBucket(
  series: Series[],
  firstAt: EpochMs | null,
  stepSeconds: number,
): Series[] {
  if (firstAt === null) return series
  const from = Math.floor(firstAt / (stepSeconds * 1000)) * stepSeconds * 1000
  return series.map((s) => ({ ...s, points: s.points.filter(([t]) => t >= from) }))
}

/** One row of the token table: a person, machine or subscription. */
export interface TokenRow {
  key: string
  byType: Record<TokenType, number>
  /** The chosen type's total (all four summed for 'all'). */
  total: number
  /** The chosen type's points, for the trend. */
  points: Array<[EpochMs, number]>
}

/**
 * Rows from one query per token type, each grouped by the same dimension and on the same grid:
 * every key with any tokens in the range, with its four totals, the chosen total and trend,
 * largest chosen total first (ties by name). A key that appears with no tokens of any type
 * (a label CloudWatch still lists) has no row.
 */
export function tokenRows(
  byType: Partial<Record<TokenType, readonly Series[]>>,
  choice: TokenChoice,
): TokenRow[] {
  const keys = new Set<string>()
  for (const type of TOKEN_TYPES) for (const s of byType[type] ?? []) keys.add(s.key)
  const rows: TokenRow[] = []
  for (const key of keys) {
    const totals = {} as Record<TokenType, number>
    const trend = new Map<EpochMs, number>()
    for (const type of TOKEN_TYPES) {
      const series = (byType[type] ?? []).find((s) => s.key === key)
      totals[type] = series?.points.reduce((sum, [, v]) => sum + v, 0) ?? 0
      if (choice !== 'all' && choice !== type) continue
      for (const [t, v] of series?.points ?? []) trend.set(t, (trend.get(t) ?? 0) + v)
    }
    if (TOKEN_TYPES.every((type) => totals[type] === 0)) continue
    const total =
      choice === 'all' ? TOKEN_TYPES.reduce((sum, type) => sum + totals[type], 0) : totals[choice]
    rows.push({
      key,
      byType: totals,
      total,
      points: [...trend.entries()].sort((a, b) => a[0] - b[0]),
    })
  }
  return rows.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
}

/** The four types' sums over [from, to), from one query grouped by type. */
export function tokensBetween(
  byTypeSeries: readonly Series[],
  from: EpochMs,
  to: EpochMs,
): Record<TokenType, number> {
  const out = { input: 0, output: 0, cache_read: 0, cache_creation: 0 } as Record<TokenType, number>
  for (const s of byTypeSeries) {
    if (!(TOKEN_TYPES as readonly string[]).includes(s.key)) continue
    for (const [t, v] of s.points) if (t >= from && t < to) out[s.key as TokenType] += v
  }
  return out
}
