import type { EpochMs } from './types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A countdown such as "3d 2h", "2h 12m", "12m" or "40s"; "now" when it has passed. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY)
    const hours = Math.floor((ms % DAY) / HOUR)
    // Past two days the hours say little (a clock time is usually beside it): days only.
    return hours === 0 || days >= 2 ? `${days}d` : `${days}d ${hours}h`
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }
  if (ms >= MINUTE) return `${Math.floor(ms / MINUTE)}m`
  return `${Math.ceil(ms / 1000)}s`
}

/** A share as a percentage: whole from 10% ("42%"), one decimal below ("2.5%"); a dash if unknown. */
export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—'
  const percent = fraction * 100
  // One decimal where rounding would mislead: under 10%, and just short of 100%.
  if (percent !== 0 && (Math.abs(percent) < 10 || (percent >= 99.5 && percent < 100))) {
    return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`
  }
  return `${Math.round(percent)}%`
}

/** A count with thousands grouped, or compacted past 10,000 ("12.4k"). */
export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    )
  }
  return new Intl.NumberFormat('en').format(Math.round(value))
}

/** US dollars as "$1,240", "$38.20" or "$0.42"; under a cent as "<$0.01". */
export function formatDollars(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  if (Math.abs(value) < 0.005) return '<$0.01'
  const digits = Math.round(Math.abs(value) * 100) / 100 >= 100 ? 0 : 2
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

/** Milliseconds as "840 ms" or "14.2 s". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** A wall-clock time in the viewer's zone: "2:05 PM" today, "Thu 2:05 PM" within a week, else a date. */
export function formatWhen(at: EpochMs, now: EpochMs, timeZone?: string): string {
  // A 12-hour clock ("2:05 PM"); the space before AM/PM is a plain one whatever the engine
  // (some put a narrow no-break space there), so the server and the browser write the same.
  const options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }
  if (timeZone !== undefined) options.timeZone = timeZone
  const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, ' ')
  const day = (t: EpochMs) =>
    new Intl.DateTimeFormat('en-CA', {
      ...options,
      hour: undefined,
      minute: undefined,
      hourCycle: undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(t)
  if (day(at) === day(now)) return plain(new Intl.DateTimeFormat('en-US', options).format(at))
  if (Math.abs(at - now) < 6 * DAY) {
    return plain(new Intl.DateTimeFormat('en-US', { ...options, weekday: 'short' }).format(at))
  }
  return plain(
    new Intl.DateTimeFormat('en-US', { ...options, month: 'short', day: 'numeric' }).format(at),
  )
}

/** The cookie in which the browser tells the server the viewer's time zone. */
export const TIME_ZONE_COOKIE = 'cmd-tz'

/**
 * An IANA time zone name the formatter accepts, or null: a cookie value is the viewer's to set,
 * so anything else is ignored rather than trusted.
 */
export function timeZoneOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null
  if (!/^[A-Za-z0-9_+\-/]+$/.test(value)) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return value
  } catch {
    return null
  }
}
