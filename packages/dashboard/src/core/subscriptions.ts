import type { EpochMs, Series, SeriesQuery } from './types'

/** How long a subscription still counts after its last band reading. */
export const SUBSCRIPTION_HOLD_MS = 60 * 60_000

/**
 * How many subscriptions were in the pool at each step of `query`'s grid, from their quota band
 * readings as the source returned them (not zero-filled; one point per bucket, at the bucket's
 * start): one counts in a step when it has a finite reading in that step or in a bucket that
 * ended within SUBSCRIPTION_HOLD_MS before it, so a missed export or the step CloudWatch has not
 * filled yet does not drop it. A subscription added shows as a step up; one removed, a step down
 * an hour after its last bucket.
 */
export function subscriptionCount(
  readings: readonly Series[],
  query: Pick<SeriesQuery, 'range' | 'stepSeconds'>,
  holdMs: number = SUBSCRIPTION_HOLD_MS,
): Array<[EpochMs, number]> {
  const stepMs = query.stepSeconds * 1000
  const times = readings.map((s) =>
    s.points
      .filter(([, v]) => Number.isFinite(v))
      .map(([t]) => t)
      .sort((a, b) => a - b),
  )
  const out: Array<[EpochMs, number]> = []
  for (
    let at = Math.ceil(query.range.start / stepMs) * stepMs;
    at < query.range.end;
    at += stepMs
  ) {
    let count = 0
    for (const ts of times) {
      // A reading before the step's end whose bucket ended no longer than the hold ago.
      if (ts.some((t) => t < at + stepMs && t + stepMs > at - holdMs)) count++
    }
    out.push([at, count])
  }
  return out
}
