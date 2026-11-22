import type { EpochMs } from './types'

/** The most a reminder's title may hold: a profile name and a window's name fit many times over. */
export const CALENDAR_TITLE_MAX = 200

/**
 * One moment as an iCalendar file: a 15-minute event with `title` at `at`, for a reminder at a reset.
 * The title's control characters and iCalendar separators become spaces.
 */
export function calendarIcs(title: string, at: EpochMs): string {
  const stamp = (t: EpochMs) =>
    new Date(t)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const summary = title.slice(0, CALENDAR_TITLE_MAX).replace(/[\u0000-\u001f\u007f;,]/g, ' ')
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//claw-master//dashboard//EN',
    'BEGIN:VEVENT',
    `UID:${at}-${summary.replace(/[^A-Za-z0-9]/g, '')}@claw-master`,
    `DTSTAMP:${stamp(at)}`,
    `DTSTART:${stamp(at)}`,
    `DTEND:${stamp(at + 15 * 60_000)}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
}
