// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarIcs, HOUR_MS, type ProfileStatus, WEEK_MS } from '../src/core/index'
import { calendarResponse } from '../src/next/index'
import { CalendarBaseContext, PoolAccounts } from '../src/react/Pool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.UTC(2026, 10, 22, 18, 0, 0)
let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('a reset as a calendar file', () => {
  it('is served by the API, so a phone opens it in its calendar', async () => {
    const at = NOW + 50 * HOUR_MS
    const response = calendarResponse(
      new URLSearchParams({ title: 'alpha: weekly limit resets', at: String(at) }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    const body = await response.text()
    expect(body).toBe(calendarIcs('alpha: weekly limit resets', at))
    expect(body).toContain('SUMMARY:alpha: weekly limit resets')
    expect(body).toContain('DTSTART:20261124T200000Z')
    // A reset read from a countdown has a fraction of a millisecond (seen live).
    expect(calendarResponse(new URLSearchParams({ title: 'x', at: `${at}.4534` })).status).toBe(200)
  })

  it('refuses a missing or overlong title and a time out of range', () => {
    for (const params of [
      { at: String(NOW + HOUR_MS) },
      { title: 'x'.repeat(201), at: String(NOW + HOUR_MS) },
      { title: 'x', at: 'soon' },
      { title: 'x', at: String(NOW + 400 * 24 * HOUR_MS) },
    ]) {
      expect(calendarResponse(new URLSearchParams(params)).status).toBe(400)
    }
  })

  it('keeps line breaks and separators out of the event', () => {
    expect(calendarIcs('a\r\nBEGIN:VEVENT;b,c', NOW)).toContain('SUMMARY:a  BEGIN:VEVENT b c')
  })
})

const sub = (fableReset: number): ProfileStatus => ({
  profile: 'team-alpha',
  band: 'ok',
  weekly: { usedFraction: 0.1, resetsAt: NOW + 50 * HOUR_MS, lengthMs: WEEK_MS },
  fiveHour: null,
  rateLimitedUntil: null,
  tokenExpiresAt: null,
  latencyMs: { p50: null, p95: null, p99: null },
  fable: { usedFraction: 0, resetsAt: fableReset, refusedUntil: null },
})

describe('the subscription detail', () => {
  const open = (profile: ProfileStatus, base: string) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <CalendarBaseContext.Provider value={base}>
          <PoolAccounts profiles={[profile]} now={NOW} />
        </CalendarBaseContext.Provider>,
      ),
    )
    act(() => (container.querySelector('.cmd-account button') as HTMLButtonElement).click())
    return container.querySelector('.cmd-account-detail') as HTMLElement
  }

  it("links a reset to the API's calendar file, and says Fable resets with the week", () => {
    const fractional = sub(NOW + 50 * HOUR_MS + 30_000)
    fractional.weekly = { ...fractional.weekly, resetsAt: NOW + 50 * HOUR_MS + 0.4534 }
    const detail = open(fractional, '/api/claw-master')
    const link = detail.querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toMatch(
      /^\/api\/claw-master\/reset\.ics\?title=team-alpha%3A\+weekly\+limit\+resets&at=\d+$/,
    )
    expect(link.hasAttribute('download')).toBe(false)
    expect(detail.textContent).toContain('Fable 0% used · resets with the week')
    expect(detail.querySelectorAll('a')).toHaveLength(1)
  })

  it('gives Fable its own reset when it differs from the week', () => {
    const detail = open(sub(NOW + 20 * HOUR_MS), '')
    expect(detail.textContent).not.toContain('resets with the week')
    expect(detail.textContent).toContain('Fable 0% used · resets in 20h')
    expect(detail.querySelectorAll('a')).toHaveLength(1)
    expect((detail.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toMatch(
      /^data:text\/calendar/,
    )
  })
})
