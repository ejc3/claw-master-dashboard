import { projectedExhaustion } from './pace'
import { type EpochMs, HOUR_MS, type ProfileStatus, type QuotaWindow } from './types'

export interface RunOut {
  profile: string
  window: 'weekly' | 'fiveHour'
  at: EpochMs
}

// Whether the usage poll reads a window as used up, while its reset is still ahead (or unknown).
function readFull(window: QuotaWindow | null, now: EpochMs): boolean {
  if (window === null || window.usedFraction === null || window.usedFraction < 1) return false
  return window.resetsAt === null || window.resetsAt > now
}

/**
 * Whether a subscription's week is read as used up until its reset: nothing of a 5-hour window
 * can be used then, so the 5-hour reading says nothing.
 */
export function weekUsedUp(profile: ProfileStatus, now: EpochMs): boolean {
  return readFull(profile.weekly, now)
}

/**
 * A 5-hour window as of `at`: as read while its reset is ahead (or unknown); once the reset has
 * passed, no window is open (nothing used, no reset time) until the next request opens one.
 */
export function fiveHourAt(window: QuotaWindow | null, at: EpochMs): QuotaWindow | null {
  if (window === null || window.resetsAt === null || window.resetsAt > at) return window
  return { usedFraction: 0, resetsAt: null, lengthMs: window.lengthMs }
}

/**
 * Why a subscription cannot take work right now, and until when (null when unknown, e.g. a
 * login that has expired needs someone to fix it). Anthropic refusing it (a 429, which
 * claw-master holds as rate-limited until Anthropic's reset) takes it out. So does the usage poll
 * reading a window as used up when Anthropic has not taken the subscription's work in the last
 * ACCEPTED_RECENTLY_MS: the poll reads whole percents, so its 100% can still be under Anthropic's,
 * but only work Anthropic is still accepting shows that (see pollSaysUsedUp). Without it the
 * subscription stays out until that window resets.
 */
export type Blocked =
  | { reason: 'no-reading'; until: null }
  | { reason: 'login-expired'; until: null }
  | { reason: 'rate-limited'; until: EpochMs | null }
  | { reason: 'used-up'; until: EpochMs | null }

/** How recently Anthropic must have accepted a subscription's work for the poll's 100% to leave it nearly out. */
export const ACCEPTED_RECENTLY_MS = 15 * 60_000

/**
 * Whether Anthropic took the subscription's work lately; a source that cannot tell counts as yes.
 * The reading is the start of a minute at or before the snapshot, so a later one is not believed.
 */
function acceptedRecently(profile: ProfileStatus, now: EpochMs): boolean {
  const at = profile.acceptedAt
  return at === undefined || (at !== null && at >= now - ACCEPTED_RECENTLY_MS && at <= now + 60_000)
}

/** Null when the subscription can take work. */
export function blocked(profile: ProfileStatus, now: EpochMs): Blocked | null {
  if (profile.band === 'unknown') return { reason: 'no-reading', until: null }
  if (profile.tokenExpiresAt !== null && profile.tokenExpiresAt <= now) {
    return { reason: 'login-expired', until: null }
  }
  if (profile.rateLimitedUntil !== null && profile.rateLimitedUntil > now) {
    return { reason: 'rate-limited', until: profile.rateLimitedUntil }
  }
  // Back when every used-up window has reset: the later reset, unknown if either is.
  const full = [profile.weekly, fiveHourAt(profile.fiveHour, now)].filter((w): w is QuotaWindow =>
    readFull(w, now),
  )
  if (full.length > 0 && !acceptedRecently(profile, now)) {
    const resets = full.map((w) => w.resetsAt)
    const until = resets.includes(null) ? null : Math.max(...(resets as EpochMs[]))
    return { reason: 'used-up', until }
  }
  return null
}

/**
 * Whether the usage poll reads a subscription's week or open 5-hour window as used up while
 * Anthropic is still accepting its work: nearly out, its last percent or so still taking work.
 */
export function pollSaysUsedUp(profile: ProfileStatus, now: EpochMs): boolean {
  return (
    blocked(profile, now) === null &&
    (readFull(profile.weekly, now) || readFull(fiveHourAt(profile.fiveHour, now), now))
  )
}

/**
 * What the 5-hour window really leaves a subscription now, as a share of it (null with no
 * reading): nothing while Anthropic refuses it, and never more than its week leaves, since work
 * in the window also spends the week. A window with no reading still shows nothing left when the
 * week is used up.
 */
export function fiveHourLeft(profile: ProfileStatus, now: EpochMs): number | null {
  if (blocked(profile, now)?.reason === 'rate-limited') return 0
  const clamp = (f: number | null | undefined) =>
    f === null || f === undefined || !Number.isFinite(f) ? null : Math.min(1, Math.max(0, f))
  const weekUsed = clamp(profile.weekly.usedFraction)
  const weekLeft = weekUsed === null ? null : 1 - weekUsed
  const fiveUsed = clamp(fiveHourAt(profile.fiveHour, now)?.usedFraction)
  if (fiveUsed === null) return weekLeft === 0 ? 0 : null
  return Math.min(1 - fiveUsed, weekLeft ?? 1)
}

/** What a usage poll's 100% leaves, at most: it reads whole percents. */
export const POLL_FULL_LEFT = 0.01

/**
 * The subscriptions as the forecast should see them: a window the poll reads as used up keeps
 * POLL_FULL_LEFT while Anthropic still accepts the subscription's work, so the forecast has it run
 * out shortly instead of being out already. A refused subscription whose refusal ends before the
 * window resets gets it too (claw-master asks Anthropic again then); one refused through the reset,
 * or one Anthropic has not taken work from lately, has nothing left of that window, so it stays as
 * read (else the forecast would count that percent as left unused at the reset).
 */
export function forecastProfiles(profiles: ProfileStatus[], now: EpochMs): ProfileStatus[] {
  return profiles.map((p) => {
    const cap = (w: QuotaWindow | null): QuotaWindow | null => {
      if (w === null || w.usedFraction === null || w.usedFraction < 1) return w
      const refusedThroughReset =
        p.rateLimitedUntil !== null && w.resetsAt !== null && p.rateLimitedUntil >= w.resetsAt
      const refusedForNow = p.rateLimitedUntil !== null && p.rateLimitedUntil > now
      const keepsLastPercent = !refusedThroughReset && (refusedForNow || acceptedRecently(p, now))
      return keepsLastPercent ? { ...w, usedFraction: 1 - POLL_FULL_LEFT } : w
    }
    return { ...p, weekly: cap(p.weekly) ?? p.weekly, fiveHour: cap(p.fiveHour) }
  })
}

export function hasHeadroom(profile: ProfileStatus, now: EpochMs): boolean {
  return blocked(profile, now) === null
}

/** The soonest a subscription with headroom runs out of a window before it resets. */
export function nextRunOut(profiles: ProfileStatus[], now: EpochMs): RunOut | null {
  let soonest: RunOut | null = null
  const consider = (profile: string, window: RunOut['window'], quota: QuotaWindow | null) => {
    if (quota === null) return
    const at = projectedExhaustion(quota, now)
    if (at !== null && (soonest === null || at < soonest.at)) soonest = { profile, window, at }
  }
  for (const p of profiles) {
    if (!hasHeadroom(p, now)) continue
    consider(p.profile, 'weekly', p.weekly)
    consider(p.profile, 'fiveHour', p.fiveHour)
  }
  return soonest
}

/** When the first blocked subscription can take work again, if any of them will on its own. */
export function nextAvailable(
  profiles: ProfileStatus[],
  now: EpochMs,
): { profile: string; at: EpochMs } | null {
  let soonest: { profile: string; at: EpochMs } | null = null
  for (const p of profiles) {
    const b = blocked(p, now)
    if (b?.until != null && (soonest === null || b.until < soonest.at)) {
      soonest = { profile: p.profile, at: b.until }
    }
  }
  return soonest
}

/**
 * claude-master renews a subscription's login once less than four hours of it are left, checking
 * every quarter of an hour. Less than this left means a renewal is overdue: worth a warning before
 * the login expires and the subscription stops taking work.
 */
export const LOGIN_OVERDUE_MS = 3 * HOUR_MS

/** Whether the login is still valid but should have been renewed by now. */
export function loginOverdue(profile: ProfileStatus, now: EpochMs): boolean {
  const at = profile.tokenExpiresAt
  return at !== null && at > now && at - now < LOGIN_OVERDUE_MS
}
