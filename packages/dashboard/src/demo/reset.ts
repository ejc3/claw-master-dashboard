import type { EpochMs, MetricsSource, ProfileStatus, Snapshot } from '../core/types'
import { createDemoSource, type DemoOptions } from './index'

const HOUR_MS = 3_600_000
const WEEK_MS = 7 * 24 * HOUR_MS
const FIVE_HOURS_MS = 5 * HOUR_MS

/**
 * One loop of the reset scenario: out for the first two and a half minutes, back for the last one
 * and a half. The reset falls mid-minute, as real ones do.
 */
export const RESET_CYCLE_MS = 4 * 60_000
const OUT_FOR_MS = 150_000

/** When the current loop's 5-hour window resets: two and a half minutes into the loop. */
export function scenarioResetAt(now: EpochMs): EpochMs {
  return Math.floor(now / RESET_CYCLE_MS) * RESET_CYCLE_MS + OUT_FOR_MS
}

/**
 * The demo, with the pool out of quota until a 5-hour window resets, on a four-minute loop by the
 * server's clock: for two and a half minutes Anthropic refuses every subscription (alpha until
 * its 5-hour window resets, the others until their weeks do) and the page counts down to alpha's
 * reset; at zero alpha's window has reset and it takes work again until the loop starts over. For trying the countdown and the return of
 * quota on the real page; the charts and tables are the ordinary demo's.
 */
export function createResetScenarioSource(options: DemoOptions = {}): MetricsSource {
  const clock = options.now ?? Date.now
  const demo = createDemoSource(options)
  return {
    ...demo,
    async snapshot(): Promise<Snapshot> {
      const base = await demo.snapshot()
      const now = clock()
      const resetAt = scenarioResetAt(now)
      const reset = now >= resetAt
      const profiles = base.profiles.map((p, i): ProfileStatus => {
        if (i === 0) {
          return {
            ...p,
            band: 'ok',
            // Refused (a 429) until its 5-hour window resets; nothing after.
            rateLimitedUntil: reset ? null : resetAt,
            weekly: { usedFraction: 0.6, resetsAt: now + 3 * 24 * HOUR_MS, lengthMs: WEEK_MS },
            // Used up until the reset; after it no window is open, as Anthropic reports it.
            fiveHour: reset
              ? { usedFraction: 0, resetsAt: null, lengthMs: FIVE_HOURS_MS }
              : { usedFraction: 1, resetsAt: resetAt, lengthMs: FIVE_HOURS_MS },
          }
        }
        const weekEnds = now + (1 + i) * 24 * HOUR_MS
        return {
          ...p,
          band: 'exhausted',
          // Refused until its week resets.
          rateLimitedUntil: weekEnds,
          weekly: { usedFraction: 1, resetsAt: weekEnds, lengthMs: WEEK_MS },
          // A 5-hour limit with no window open: null would read as a plan with none.
          fiveHour: { usedFraction: 0, resetsAt: null, lengthMs: FIVE_HOURS_MS },
        }
      })
      return { ...base, asOf: now, profiles }
    },
  }
}
