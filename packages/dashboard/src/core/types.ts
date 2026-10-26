/** Milliseconds since the Unix epoch. */
export type EpochMs = number

/** How much of a subscription's allowance is left, as claude-master classifies it. */
export type Band = 'ok' | 'reserve' | 'exhausted' | 'unknown'

/** One rate-limit window of a subscription: the weekly allowance or the 5-hour session. */
export interface QuotaWindow {
  /** Share of the window's allowance used, 0 to 1; null when the source has no reading. */
  usedFraction: number | null
  /** When the window resets; null when unknown. */
  resetsAt: EpochMs | null
  /** The window's length, so the share of it that has elapsed can be computed. */
  lengthMs: number
}

export interface LatencyQuantiles {
  p50: number | null
  p95: number | null
  p99: number | null
}

/** The latest state of one subscription (a claude-master profile). */
export interface ProfileStatus {
  profile: string
  band: Band
  weekly: QuotaWindow
  /** Null when the source does not report the 5-hour window. */
  fiveHour: QuotaWindow | null
  /** When claude-master tries the subscription again after Anthropic rate-limited it (a 429); null when it is not rate-limited. */
  rateLimitedUntil: EpochMs | null
  /** When the profile's login token expires; null when unknown. */
  tokenExpiresAt: EpochMs | null
  /** Request duration over the proxy's recent requests, in ms. */
  latencyMs: LatencyQuantiles
  /**
   * The latest minute in which Anthropic accepted the subscription's work (its overall rate-limit
   * status allowed or allowed_warning) within the snapshot's look-back; null when it accepted none
   * there; absent when the source cannot tell.
   */
  acceptedAt?: EpochMs | null
  /**
   * The email of the Anthropic account the profile is logged in to (claw_master.profile.info);
   * null when not reported; absent when the source cannot tell.
   */
  email?: string | null
}

/** Everything the dashboard shows as "now". */
export interface Snapshot {
  /** When the newest reading in this snapshot was taken. */
  asOf: EpochMs
  profiles: ProfileStatus[]
  /** Conversations bound to a subscription. */
  sessions: number | null
  activeConnections: number | null
}

/**
 * The axes claude-master splits its metrics by. A metric carries a few of them (at most three
 * for the metrics the dashboard reads); a split by another axis is a separate metric.
 */
export type Dimension =
  | 'profile'
  | 'client'
  | 'client_account'
  | 'project'
  | 'model'
  | 'status_class'
  | 'status'
  | 'reason'
  | 'from'
  | 'to'
  | 'result'
  | 'type'

/**
 * The four kinds of token Anthropic reports in a response's usage: fresh input, output (thinking
 * included), input read from the prompt cache and input written to it. claude-master counts each
 * under the `type` attribute; `cache_creation` is what the page calls cache write.
 */
export type TokenType = 'input' | 'output' | 'cache_read' | 'cache_creation'

export const TOKEN_TYPES: readonly TokenType[] = ['input', 'output', 'cache_read', 'cache_creation']

/** What a chart asks for, independent of where the numbers are stored. */
export type SemanticMetric =
  | 'requests'
  | 'errors'
  | 'switches'
  | 'rateLimited'
  | 'backupRequests'
  | 'ttfbMs'
  | 'durationMs'
  | 'upstreamTtfbMs'
  | 'overheadMs'
  | 'weeklyUsed'
  | 'fiveHourUsed'
  | 'weeklyResetsInSeconds'
  | 'fiveHourResetsInSeconds'
  | 'tokenExpiresInSeconds'
  | 'tokens'

export interface TimeRange {
  start: EpochMs
  end: EpochMs
}

export interface SeriesQuery {
  metric: SemanticMetric
  /** One line per value of this dimension; omitted for a single total line. */
  groupBy?: Dimension
  range: TimeRange
  /** Width of each point's bucket. */
  stepSeconds: number
  /** Only this kind of token (tokens only); omitted, every kind is summed. */
  tokenType?: TokenType
}

export interface Series {
  /** The group's value (e.g. a profile name), or 'total' for an ungrouped query. */
  key: string
  /** [bucket start, value], oldest first. */
  points: Array<[EpochMs, number]>
}

/** Where the numbers come from: CloudWatch, Prometheus, a fixture. */
/** A CloudWatch alarm on claude-master, in the state it is in and since when. */
export interface AlarmStatus {
  name: string
  state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA'
  /** When it entered this state. */
  since: EpochMs
}

export interface MetricsSource {
  snapshot(): Promise<Snapshot>
  series(query: SeriesQuery): Promise<Series[]>
  /** claude-master's alarms; a source without alarms (none to read) may leave it out. */
  alarms?(): Promise<AlarmStatus[]>
}

export const HOUR_MS = 60 * 60 * 1000
export const FIVE_HOURS_MS = 5 * HOUR_MS
export const WEEK_MS = 7 * 24 * HOUR_MS
