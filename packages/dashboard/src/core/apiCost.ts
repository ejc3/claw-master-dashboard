import type { EpochMs, Series, TokenType } from './types'
import { TOKEN_TYPES } from './types'

/**
 * US dollars per million tokens of each type at the Claude API's standard rates (cache writes at
 * the 5-minute rate), the rate of an hour-long cache write, and fast mode's multiple of them all
 * (null: the model has no fast mode).
 */
type Rates = Record<TokenType, number> & { write1h: number; fast: number | null }

const rates = (
  input: number,
  write5m: number,
  write1h: number,
  cacheRead: number,
  output: number,
  fast: number | null = null,
): Rates => ({ input, cache_creation: write5m, write1h, cache_read: cacheRead, output, fast })

/**
 * Anthropic's price list (https://platform.claude.com/docs/en/about-claude/pricing), read
 * 2026-11-24, by model alias: input, 5-minute and 1-hour cache writes, cache reads, output, and
 * fast mode's multiple. Haiku 5.5's long-prompt rate is not priced: the counts do not say which
 * prompts were long. Update it when Anthropic changes a price or ships a model; public names only.
 */
export const API_PRICES: Readonly<Record<string, Rates>> = {
  'claude-fable-5-2': rates(8, 10, 16, 0.2, 40, 2),
  'claude-mythos-5-2': rates(8, 10, 16, 0.2, 40, 2),
  'claude-fable-5-1': rates(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': rates(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': rates(10, 12.5, 20, 1, 50),
  'claude-mythos-5': rates(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': rates(4, 5, 8, 0.2, 20, 2),
  'claude-opus-5': rates(5, 6.25, 10, 0.5, 25, 2),
  'claude-opus-4-8': rates(5, 6.25, 10, 0.5, 25, 2),
  'claude-opus-4-7': rates(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': rates(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': rates(5, 6.25, 10, 0.5, 25),
  'claude-sonnet-5-5': rates(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': rates(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': rates(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': rates(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': rates(0.1, 0.125, 0.2, 0.01, 0.5),
  'claude-haiku-4-5': rates(1, 1.25, 2, 0.1, 5),
}

/**
 * What one token of a type billed at a premium rate costs above the standard rate, in dollars per
 * million: "1h" an hour-long cache write, "fast" a fast-mode token, "fast_1h" a fast-mode
 * hour-long cache write. Zero for a rate the model does not have.
 */
export function premiumExtra(price: Rates, type: TokenType, rate: string): number {
  const base = price[type]
  const oneHour = type === 'cache_creation' ? price.write1h : base
  const fast = price.fast ?? 1
  switch (rate) {
    case '1h':
      return oneHour - base
    case 'fast':
      return base * fast - base
    case 'fast_1h':
      return oneHour * fast - base
    default:
      return 0
  }
}

/**
 * A model's rates by its alias: a dated id ("-20251001") and a platform's id
 * ("us.anthropic.…-v1:0") name the same model. Null for a model the list does not name.
 */
export function apiPriceOf(model: string): Rates | null {
  const alias = model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z]{2}\.|global\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '')
  return API_PRICES[alias] ?? null
}

/** The map under `key`, made and kept there if there was none. */
function child<K, V>(map: Map<K, Map<string, V>>, key: K): Map<string, V> {
  let found = map.get(key)
  if (found === undefined) {
    found = new Map()
    map.set(key, found)
  }
  return found
}

/** A token query split by type ("<group> <type>" keys) as time -> type -> group -> tokens. */
function byTime(series: readonly Series[]): Map<EpochMs, Map<TokenType, Map<string, number>>> {
  const out = new Map<EpochMs, Map<TokenType, Map<string, number>>>()
  for (const s of series) {
    const at = s.key.lastIndexOf(' ')
    const type = s.key.slice(at + 1) as TokenType
    if (at < 0 || !TOKEN_TYPES.includes(type)) continue
    const group = s.key.slice(0, at)
    for (const [t, v] of s.points) {
      if (!(v > 0)) continue
      let types = out.get(t)
      if (types === undefined) {
        types = new Map()
        out.set(t, types)
      }
      const groups = child(types, type)
      groups.set(group, (groups.get(group) ?? 0) + v)
    }
  }
  return out
}

const sum = (m: ReadonlyMap<string, number> | undefined) =>
  m === undefined ? 0 : [...m.values()].reduce((a, b) => a + b, 0)

/** Premium token series ("<group> <type>@<rate>" keys) as time -> "type@rate" -> group -> tokens. */
function premiumByTime(series: readonly Series[]): Map<EpochMs, Map<string, Map<string, number>>> {
  const out = new Map<EpochMs, Map<string, Map<string, number>>>()
  for (const s of series) {
    const at = s.key.lastIndexOf(' ')
    const typeRate = s.key.slice(at + 1)
    const type = typeRate.slice(0, typeRate.indexOf('@')) as TokenType
    if (at < 0 || !typeRate.includes('@') || !TOKEN_TYPES.includes(type)) continue
    const group = s.key.slice(0, at)
    for (const [t, v] of s.points) {
      if (!(v > 0)) continue
      let rates = out.get(t)
      if (rates === undefined) {
        rates = new Map()
        out.set(t, rates)
      }
      const groups = child(rates, typeRate)
      groups.set(group, (groups.get(group) ?? 0) + v)
    }
  }
  return out
}

export interface ApiCost {
  /** Dollars by person and by model; both add up to `total`. */
  people: Map<string, number>
  models: Map<string, number>
  total: number
  /**
   * Until when the models' share was estimated from request counts, because tokens by model were
   * not counted yet; null when none was.
   */
  estimatedUntil: EpochMs | null
}

/**
 * What the range's tokens would cost at Claude API prices, by person and by model, from the
 * token counts claw-master keeps: by person and type, by model and type, and requests by model.
 * Its metrics never split one person's tokens by model, so each step's cost of each token type
 * is shared out to the people by their tokens of that type, which is exact for a step where one
 * person worked and close otherwise (the steps are short). The step's total tokens are the
 * people's, priced at the models' mix. Before tokens by model were counted, the mix comes from each
 * step's requests by model times each model's tokens per request where both were counted.
 * Tokens billed above the standard rate (hour-long cache writes, fast mode), counted again by
 * person and by model under their rate, add their extra the same way, from when they were counted.
 */
export function apiCost(
  people: readonly Series[],
  models: readonly Series[],
  requests: readonly Series[],
  premium: { people: readonly Series[]; models: readonly Series[] } = { people: [], models: [] },
): ApiCost | null {
  const P = byTime(people)
  const M = byTime(models)
  if (M.size === 0) return null
  const modelsFrom = Math.min(...M.keys())
  // Requests by model at each step.
  const R = new Map<EpochMs, Map<string, number>>()
  for (const s of requests) {
    for (const [t, v] of s.points) {
      if (!(v > 0)) continue
      const at = child(R, t)
      at.set(s.key, (at.get(s.key) ?? 0) + v)
    }
  }
  // Each model's tokens of each type per request, over the steps that counted both.
  const perRequest = new Map<string, number>()
  const counted = new Map<string, number>()
  for (const [t, at] of R) {
    if (t < modelsFrom) continue
    for (const [model, n] of at) counted.set(model, (counted.get(model) ?? 0) + n)
    for (const type of TOKEN_TYPES) {
      for (const [model, x] of M.get(t)?.get(type) ?? []) {
        if (!at.has(model)) continue
        const key = `${model} ${type}`
        perRequest.set(key, (perRequest.get(key) ?? 0) + x)
      }
    }
  }
  for (const [key, x] of perRequest) {
    const n = counted.get(key.slice(0, key.lastIndexOf(' '))) ?? 0
    perRequest.set(key, n > 0 ? x / n : 0)
  }

  const byPerson = new Map<string, number>()
  const byModel = new Map<string, number>()
  let estimatedUntil: EpochMs | null = null
  for (const [t, types] of P) {
    for (const [type, who] of types) {
      const tokens = sum(who)
      let mix = t >= modelsFrom ? M.get(t)?.get(type) : undefined
      const estimated = mix === undefined || sum(mix) === 0
      if (estimated) {
        mix = new Map()
        for (const [model, n] of R.get(t) ?? []) {
          const w = n * (perRequest.get(`${model} ${type}`) ?? 0)
          if (w > 0) mix.set(model, w)
        }
      }
      const weight = sum(mix)
      if (mix === undefined || weight === 0) continue
      let cost = 0
      for (const [model, w] of mix) {
        const price = apiPriceOf(model)
        if (price === null) continue
        const dollars = ((tokens * w) / weight) * (price[type] / 1e6)
        cost += dollars
        byModel.set(model, (byModel.get(model) ?? 0) + dollars)
      }
      for (const [person, x] of who) {
        byPerson.set(person, (byPerson.get(person) ?? 0) + (cost * x) / tokens)
      }
      if (estimated && t < modelsFrom && cost > 0) estimatedUntil = modelsFrom
    }
  }
  // The extra for premium tokens: each model's at its rate, shared out to the people by their
  // tokens of that type and rate in the step.
  const premiumPeople = premiumByTime(premium.people)
  for (const [t, typeRates] of premiumByTime(premium.models)) {
    for (const [typeRate, byModelTokens] of typeRates) {
      const who = premiumPeople.get(t)?.get(typeRate)
      const tokens = sum(who)
      if (who === undefined || tokens === 0) continue
      const type = typeRate.slice(0, typeRate.indexOf('@')) as TokenType
      const rate = typeRate.slice(typeRate.indexOf('@') + 1)
      let extra = 0
      for (const [model, x] of byModelTokens) {
        const price = apiPriceOf(model)
        if (price === null) continue
        const dollars = (x * premiumExtra(price, type, rate)) / 1e6
        extra += dollars
        byModel.set(model, (byModel.get(model) ?? 0) + dollars)
      }
      for (const [person, x] of who) {
        byPerson.set(person, (byPerson.get(person) ?? 0) + (extra * x) / tokens)
      }
    }
  }
  const total = [...byPerson.values()].reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  return { people: byPerson, models: byModel, total, estimatedUntil }
}
