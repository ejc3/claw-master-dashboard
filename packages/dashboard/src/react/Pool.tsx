'use client'

import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  blocked,
  type CapacityAdvice,
  COVERAGE_TARGET,
  calendarIcs,
  type EarlyResets,
  type EpochMs,
  FABLE_SHARE_OF_WEEK,
  fableAt,
  fableRoom,
  fableSummary,
  fiveHourAt,
  fiveHourLeft,
  formatCountdown,
  formatPercent,
  gapsHeadline,
  HOUR_MS,
  hasHeadroom,
  noFiveHourLimit,
  outForNow,
  type PoolGaps,
  type PoolTone,
  type ProfileStatus,
  pollSaysUsedUp,
  TRACE_STEP_MS,
  weekUsedUp,
} from '../core'
import { useWhen } from './hooks'
import { LineChart, seriesColors } from './LineChart'

// Shape as well as color: check, triangle, cross, circle.
const TONE_ICON: Record<PoolTone, ReactNode> = {
  success: <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />,
  warning: (
    <path
      d="M8 2.5L14 13.5H2zM8 6.5v3.5M8 11.5v.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  ),
  error: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" />,
  info: <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />,
}

/** One color per subscription, the same on every chart, bar and row of the page. */
export function accountColors(names: string[]): Map<string, string> {
  return seriesColors(names)
}

/** The names without what they all start with ("team-alpha", "team-bravo" → "alpha", "bravo"). */
export function shortNames(names: string[]): Map<string, string> {
  let prefix = names[0] ?? ''
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1)
  // Only up to a separator, and never the whole of a name.
  const cut =
    Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.')) + 1
  return new Map(
    names.map((n) => [n, names.length > 1 && cut > 0 && cut < n.length ? n.slice(cut) : n]),
  )
}

const share = (f: number | null | undefined) =>
  f === null || f === undefined || !Number.isFinite(f) ? null : Math.min(1, Math.max(0, f))

const pct = (f: number) => `${Math.round(Math.min(1, Math.max(0, f)) * 1000) / 10}%`

const levelOf = (used: number | null) =>
  used === null ? 'unknown' : used >= 1 ? 'full' : used >= 0.9 ? 'high' : 'ok'

/**
 * One subscription's week as a horizontal bar of what is left, in its own color, and across it a
 * vertical line where Fable's reach ends: how much of the week Fable could still use, on the same axis,
 * so never past the week's fill (Fable may use at most FABLE_SHARE_OF_WEEK of it). Dashed when there
 * is no reading; no line when the week is used up.
 */
function WeekMeter(props: {
  used: number | null
  /** The Fable allowance left (0–1, as fableRoom: what is left this week); undefined for a plan without one. */
  fable?: number | null
  color: string
}) {
  const left = props.used === null ? 0 : Math.max(0, 1 - props.used)
  const fable =
    props.fable == null ? 0 : Math.min(Math.max(0, props.fable) * FABLE_SHARE_OF_WEEK, left)
  return (
    <span
      className="cmd-meter"
      data-window="weekly"
      data-level={levelOf(props.used)}
      data-left={pct(left)}
      style={{ '--cmd-account-fill': props.color } as CSSProperties}
    >
      {left > 0 && <span className="cmd-meter-week" style={{ width: pct(left) }} />}
      {props.fable !== undefined && (
        <span
          className="cmd-meter-fable"
          data-window="fable"
          data-level={levelOf(props.fable === null ? null : 1 - props.fable)}
          data-left={pct(fable)}
          hidden={props.fable === null || left <= 0}
          style={{ left: pct(fable) }}
        />
      )}
    </span>
  )
}

const RING_R = 7
const RING_C = 2 * Math.PI * RING_R

/**
 * The 5-hour window as a small ring of what is left. A subscription without a 5-hour limit shows the
 * week's room instead, dimmed (the limit does not apply); no reading is a dashed ring.
 */
function FiveRing(props: { used: number | null; color: string }) {
  const { used } = props
  const left = used === null ? null : Math.min(1, Math.max(0, 1 - used))
  return (
    <svg
      className="cmd-ring"
      viewBox="0 0 20 20"
      data-window="fiveHour"
      data-level={levelOf(used)}
      data-left={pct(left ?? 0)}
      style={{ '--cmd-account-fill': props.color } as CSSProperties}
      aria-hidden="true"
    >
      <circle className="cmd-ring-track" cx="10" cy="10" r={RING_R} />
      {left !== null && left > 0 && (
        <circle
          className="cmd-ring-left"
          cx="10"
          cy="10"
          r={RING_R}
          strokeDasharray={`${(left * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`}
          transform="rotate(-90 10 10)"
        />
      )}
    </svg>
  )
}

/**
 * How long the sparkle is kept when a subscription takes work again: the last star's delay plus
 * the animation (dashboard.css, .cmd-sparkle), so none is cut short.
 */
export const SPARKLE_MS = 2000

/**
 * The subscriptions that just took work again (unavailable on the last render, available now),
 * each with the count of its returns, kept for SPARKLE_MS so its sparkle can play. The count keys
 * the sparkle, so a second return while one plays starts it over. Nothing sparkles on the first
 * render: quota that was already there did not just return.
 */
export function useReturned(available: ReadonlyMap<string, boolean>): ReadonlyMap<string, number> {
  const [returned, setReturned] = useState<ReadonlyMap<string, number>>(() => new Map())
  const last = useRef<ReadonlyMap<string, boolean> | null>(null)
  const count = useRef(0)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const key = [...available].map(([k, v]) => `${k}:${v}`).join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: available is read through its key
  useEffect(() => {
    const before = last.current
    last.current = available
    if (before === null) return
    const back = [...available].filter(([k, v]) => v && before.get(k) === false).map(([k]) => k)
    if (back.length === 0) return
    setReturned((r) => {
      const next = new Map(r)
      for (const k of back) next.set(k, ++count.current)
      return next
    })
    for (const k of back) {
      clearTimeout(timers.current.get(k))
      timers.current.set(
        k,
        setTimeout(() => {
          timers.current.delete(k)
          setReturned((r) => {
            const next = new Map(r)
            next.delete(k)
            return next
          })
        }, SPARKLE_MS),
      )
    }
  }, [key])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending.values()) clearTimeout(t)
    }
  }, [])
  return returned
}

/** Four small stars that burst around a subscription's bars when it takes work again. */
function Sparkle(props: { color: string }) {
  return (
    <span className="cmd-sparkle" aria-hidden="true" style={{ color: props.color }}>
      {[0, 1, 2, 3].map((i) => (
        <svg key={i} viewBox="0 0 10 10" data-star={i} aria-hidden="true">
          <path d="M5 0 6 4 10 5 6 6 5 10 4 6 0 5 4 4Z" fill="currentColor" />
        </svg>
      ))}
    </span>
  )
}

/**
 * An iCalendar file for one moment, as a link a phone's calendar opens: a reminder at a reset.
 * Times are UTC, so it lands right in any zone.
 */
export function calendarHref(title: string, at: EpochMs, base = ''): string {
  if (base !== '')
    return `${base}/reset.ics?${new URLSearchParams({ title, at: String(Math.round(at)) })}`
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(calendarIcs(title, at))}`
}

/**
 * Where the dashboard API is mounted, for calendar links (…/reset.ics): a real file opens in a phone's
 * calendar, where Safari on iOS ignores a data: link. Empty: a data: link, for a page without the API.
 */
export const CalendarBaseContext = createContext('')

/** One window of the detail: its use, and when it resets with a link to add that to a calendar. */
function WindowDetail(props: {
  name: string
  who: string
  window: { usedFraction: number | null; resetsAt: EpochMs | null } | null
  closed?: boolean
  /** What to say with no window at all; "no reading" unless given. */
  none?: string
  now: EpochMs
}) {
  const when = useWhen()
  const calendarBase = useContext(CalendarBaseContext)
  const { window: w, now } = props
  if (w === null) return <li>{props.none ?? `${props.name}: no reading`}</li>
  if (props.closed) return <li>{props.name}: not in use</li>
  const used = share(w.usedFraction)
  const resets = w.resetsAt !== null && w.resetsAt > now ? w.resetsAt : null
  return (
    <li>
      {props.name} {formatPercent(used)} used
      {resets === null ? (
        ' · reset time unknown'
      ) : (
        <>
          {' · resets '}
          <a
            href={calendarHref(
              `${props.who}: ${props.name.toLowerCase()} limit resets`,
              resets,
              calendarBase,
            )}
            {...(calendarBase === ''
              ? { download: `${props.who}-${props.name.toLowerCase()}-reset.ics` }
              : {})}
            title="Add to calendar"
          >
            {when === null ? `in ${formatCountdown(resets - now)}` : when(resets, now)}
          </a>
          {when === null ? '' : ` (in ${formatCountdown(resets - now)})`}
        </>
      )}
    </li>
  )
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/**
 * A subscription's early resets this past week as small counted badges beside its name: red for
 * its week, blue for its Fable allowance alone. Nothing when there were none.
 */
function ResetBadges(props: { resets: EarlyResets | undefined }) {
  const r = props.resets
  if (r === undefined || (r.weekly.length === 0 && r.fable.length === 0)) return null
  const badge = (window: 'weekly' | 'fable', count: number, what: string) =>
    count === 0 ? null : (
      <span
        className="cmd-reset-badge"
        data-window={window}
        title={`Anthropic reset its ${what} early ${times(count)} this past week`}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M8.2 5.6A3.3 3.3 0 1 1 7.1 2.6" />
          <path d="M7.6 0.9 7.3 2.8 5.4 2.5" />
        </svg>
        {count}
      </span>
    )
  return (
    <span className="cmd-reset-badges" aria-hidden="true">
      {badge('weekly', r.weekly.length, 'week')}
      {badge('fable', r.fable.length, 'Fable allowance')}
    </span>
  )
}

/** The early resets, for a screen reader's reading of the cell. */
function earlyResetsSaid(r: EarlyResets | undefined): string {
  if (r === undefined) return ''
  const parts = [
    r.weekly.length > 0 ? `week reset early ${times(r.weekly.length)}` : '',
    r.fable.length > 0 ? `Fable reset early ${times(r.fable.length)}` : '',
  ].filter((part) => part !== '')
  return parts.length === 0 ? '' : `, ${parts.join(', ')} this past week`
}

/** The detail's lines for the early resets: when Anthropic gave the week or Fable back. */
function EarlyResetDetail(props: { resets: EarlyResets | undefined; now: EpochMs }) {
  const when = useWhen()
  const r = props.resets
  if (r === undefined) return null
  const at = (list: EpochMs[]) =>
    list
      .map((t) => (when === null ? `${formatCountdown(props.now - t)} ago` : when(t, props.now)))
      .join(', ')
  return (
    <>
      {r.weekly.length > 0 && (
        <li className="cmd-reset-line" data-window="weekly">
          {`Week reset early by Anthropic ${times(r.weekly.length)} this past week: ${at(r.weekly)}`}
        </li>
      )}
      {r.fable.length > 0 && (
        <li className="cmd-reset-line" data-window="fable">
          {`Fable reset early by Anthropic ${times(r.fable.length)} this past week: ${at(r.fable)}`}
        </li>
      )}
    </>
  )
}

/**
 * The detail's Fable line, read like the weekly and 5-hour lines: how much of its own allowance is
 * used and when it resets. Only when the week has less room than the allowance (Fable also spends
 * the week) does it say how much more fits. A 5-hour window or rate limit is the header's to say.
 */
function FableDetail(props: { profile: ProfileStatus; now: EpochMs }) {
  const { profile, now } = props
  if (profile.fable == null) return null
  const fable = fableAt(profile.fable, now)
  const used = share(fable.usedFraction)
  const room = fableRoom(profile, now)
  const refused = fable.refusedUntil !== null && fable.refusedUntil > now
  // A used-up week is the weekly line's to say ("100% used"), and the header's ("Out").
  const weekLimits =
    !refused &&
    !weekUsedUp(profile, now) &&
    used !== null &&
    room !== null &&
    room < 1 - used - 0.005
  const resets =
    fable.resetsAt === null || fable.resetsAt <= now
      ? ''
      : sameMoment(fable.resetsAt, profile.weekly.resetsAt)
        ? ' · resets with the week'
        : ` · resets in ${formatCountdown(fable.resetsAt - now)}`
  return (
    <li>
      {`Fable ${used === null ? 'no reading' : `${formatPercent(used)} used`}${
        !weekLimits || room === null
          ? ''
          : room < 0.005
            ? ' · the week leaves no room for more'
            : ` · the week leaves room for ${formatPercent(room)} more`
      }${resets}`}
    </li>
  )
}

/** Two reset times read a minute apart or less are one reset (the poll and headers round apart). */
function sameMoment(a: EpochMs | null, b: EpochMs | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= 60_000
}

/** Whether a subscription can take work, or until when it cannot, in words. */
function availability(p: ProfileStatus, now: EpochMs): string {
  const b = blocked(p, now)
  if (b === null) {
    return pollSaysUsedUp(p, now) ? 'Nearly out · Anthropic still takes its work' : 'Available'
  }
  if (b.reason === 'login-expired') return 'Login expired · log in again on the server'
  if (b.reason === 'no-reading') return 'No reading'
  return `Out · ${b.until === null ? 'back time unknown' : `back in ${formatCountdown(b.until - now)}`}`
}

/**
 * Subscriptions in the order the row shows them: the most of its week left first, then, among
 * those that read the same, the soonest weekly reset (unknown last); no reading at the end.
 */
export function orderByLeft(profiles: ProfileStatus[], now: EpochMs): ProfileStatus[] {
  const left = (p: ProfileStatus) => {
    const used = share(p.weekly.usedFraction)
    return used === null ? null : 1 - used
  }
  const resets = (p: ProfileStatus) =>
    p.weekly.resetsAt !== null && p.weekly.resetsAt > now ? p.weekly.resetsAt : Infinity
  return profiles
    .map((p, order) => ({ p, order }))
    .sort((a, b) => {
      const la = left(a.p)
      const lb = left(b.p)
      if (la === null || lb === null) {
        if (la !== lb) return la === null ? 1 : -1
      } else if (formatPercent(la) !== formatPercent(lb)) return lb - la
      return resets(a.p) - resets(b.p) || a.order - b.order
    })
    .map(({ p }) => p)
}

/**
 * Each subscription's weekly use (a bar, with a line where Fable's reach ends) and 5-hour use (a ring),
 * and whether it can take work. Hovering (with a mouse) or tapping one shows its detail below it: when each limit resets,
 * with a link to put that in a calendar. A mouse leaving the subscriptions, a tap anywhere else, or
 * Escape closes it.
 */
export function PoolAccounts(props: {
  profiles: ProfileStatus[]
  now: EpochMs
  /** Each subscription's color, as on the charts; defaults to accountColors of the profiles. */
  colors?: Map<string, string>
  /** What each weekly reset will leave unused at this pace (PoolGaps.unusedAtReset). */
  unusedAtReset?: PoolGaps['unusedAtReset']
  /** Each subscription's early resets over the last week (earlyResets); none while unread. */
  earlyResets?: ReadonlyMap<string, EarlyResets> | null
}) {
  const names = shortNames(props.profiles.map((p) => p.profile))
  const colors = props.colors ?? accountColors(props.profiles.map((p) => p.profile))
  const [open, setOpen] = useState<string | null>(null)
  // Where the open subscription's cell ends, so a floating detail sits right under it (wide screens).
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const openFrom = (profile: string, target: HTMLElement, toggle: boolean) => {
    const cell = target.parentElement
    if (cell !== null) setAnchor({ x: cell.offsetLeft, y: cell.offsetTop + cell.offsetHeight })
    setOpen((o) => (toggle && o === profile ? null : profile))
  }
  const returned = useReturned(
    new Map(props.profiles.map((p) => [p.profile, hasHeadroom(p, props.now)])),
  )
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open === null) return
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(null)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])
  if (props.profiles.length === 0) return null
  const shown = props.profiles.find((p) => p.profile === open) ?? null
  return (
    <div
      className="cmd-accounts"
      ref={ref}
      // A mouse's detail follows it: on a wide screen it floats over the charts, so it goes with the mouse,
      // unless focus is in it (a calendar link reached from the keyboard stays where it is).
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return
        if (document.getElementById('cmd-account-detail')?.contains(document.activeElement)) return
        setOpen(null)
      }}
    >
      <ul aria-label="What each subscription has left of its weekly and 5-hour limits">
        {orderByLeft(props.profiles, props.now).map((p) => {
          const weekly = share(p.weekly.usedFraction)
          // What the 5-hour window really leaves: nothing while refused, never more than the week.
          const fiveLeft = fiveHourLeft(p, props.now)
          const five = fiveLeft === null ? null : 1 - fiveLeft
          const available = hasHeadroom(p, props.now)
          // Out only for now (its 5-hour window, or a rate limit before the week resets): greyed.
          const fiveOut = outForNow(p, props.now)
          // Only a plan with a Fable allowance gets Fable's line: what is left of it this week, like
          // the bar itself, whether or not a 5-hour window or rate limit holds the subscription now.
          const fable = p.fable == null ? undefined : fableRoom(p, props.now)
          return (
            <li
              key={p.profile}
              className="cmd-account"
              data-open={available}
              data-five-out={fiveOut || undefined}
              data-returned={returned.has(p.profile) || undefined}
            >
              {returned.has(p.profile) && (
                <Sparkle key={returned.get(p.profile)} color={colors.get(p.profile) ?? ''} />
              )}
              <button
                type="button"
                aria-expanded={open === p.profile}
                aria-controls="cmd-account-detail"
                onClick={(event) => openFrom(p.profile, event.currentTarget, true)}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') openFrom(p.profile, event.currentTarget, false)
                }}
              >
                <span className="cmd-account-label">
                  <span className="cmd-account-name">{names.get(p.profile)}</span>
                  {/* Only on a subscription that is out: there it says why it may be back early. */}
                  {!available && <ResetBadges resets={props.earlyResets?.get(p.profile)} />}
                </span>
                <span className="cmd-account-marks" aria-hidden="true">
                  <WeekMeter
                    used={weekly}
                    color={colors.get(p.profile) ?? ''}
                    {...(fable === undefined ? {} : { fable })}
                  />
                  {/* No 5-hour limit, no ring: an empty space keeps the bars lined up. */}
                  {five === null && noFiveHourLimit(p) ? (
                    <span className="cmd-ring-none" />
                  ) : (
                    <FiveRing used={five} color={colors.get(p.profile) ?? ''} />
                  )}
                </span>
                <span className="cmd-visually-hidden">
                  {`: week ${formatPercent(weekly === null ? null : 1 - weekly)} left, 5-hour ${
                    five !== null
                      ? `${formatPercent(1 - five)} left`
                      : noFiveHourLimit(p)
                        ? 'no limit'
                        : 'no reading'
                  }${
                    fable === undefined
                      ? ''
                      : `, Fable ${fable === null ? 'no reading' : `${formatPercent(fable)} left`}`
                  }${available ? '' : ', not available'}${earlyResetsSaid(
                    props.earlyResets?.get(p.profile),
                  )}`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="cmd-accounts-legend" aria-hidden="true">
        {`Bar: week left${props.profiles.some((p) => p.fable != null) ? ' (line: Fable)' : ''} · ring: 5 hours left${
          props.profiles.some((p) => {
            const r = props.earlyResets?.get(p.profile)
            return (
              r !== undefined && r.weekly.length + r.fable.length > 0 && !hasHeadroom(p, props.now)
            )
          })
            ? ' · badge: reset early this past week (red: week, blue: Fable)'
            : ''
        }`}
      </p>
      {shown !== null && (
        <div
          id="cmd-account-detail"
          className="cmd-account-detail"
          role="status"
          style={
            anchor === null
              ? undefined
              : ({
                  '--cmd-detail-x': `${anchor.x}px`,
                  '--cmd-detail-y': `${anchor.y}px`,
                } as CSSProperties)
          }
        >
          <p>
            <b>{shown.profile}</b> · {availability(shown, props.now)}
          </p>
          {shown.email != null && <p className="cmd-account-email">{shown.email}</p>}
          <ul>
            <WindowDetail name="Weekly" who={shown.profile} window={shown.weekly} now={props.now} />
            {(() => {
              const next = props.unusedAtReset?.find((r) => r.profile === shown.profile)
              return next === undefined ? null : (
                <li>
                  At this pace {formatPercent(next.unused)} of the week goes unused at its reset
                </li>
              )
            })()}
            {/* Nothing of a 5-hour window can be used while the week is used up. */}
            {!weekUsedUp(shown, props.now) && (
              <WindowDetail
                name="5-hour"
                who={shown.profile}
                window={fiveHourAt(shown.fiveHour, props.now)}
                closed={shown.fiveHour?.resetsAt != null && shown.fiveHour.resetsAt <= props.now}
                {...(noFiveHourLimit(shown) ? { none: 'No 5-hour limit on this plan' } : {})}
                now={props.now}
              />
            )}
            {(() => {
              // A 5-hour window can use no more than the week has left: say so where the bar and
              // the charts show less than the window's own reading.
              const five = fiveHourAt(shown.fiveHour, props.now)
              const fiveUsed = share(five?.usedFraction)
              const left = fiveHourLeft(shown, props.now)
              if (weekUsedUp(shown, props.now) || blocked(shown, props.now) !== null) return null
              // An unknown reset time still leaves the reading: only a window that has reset is out.
              if (five === null || (five.resetsAt !== null && five.resetsAt <= props.now))
                return null
              if (fiveUsed === null || left === null || left >= 1 - fiveUsed - 0.005) return null
              return (
                <li>{`The week has ${formatPercent(left)} left, so the 5-hour window can use only that`}</li>
              )
            })()}
            {shown.fable != null && <FableDetail profile={shown} now={props.now} />}
            <EarlyResetDetail resets={props.earlyResets?.get(shown.profile)} now={props.now} />
            {shown.fable?.refusedUntil != null && shown.fable.refusedUntil > props.now && (
              <li>
                {`Anthropic refuses its Fable requests for ${formatCountdown(shown.fable.refusedUntil - props.now)}; they go to other subscriptions, and it serves every other model`}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

const asPercent = (v: number) => `${Math.round(v * 100)}%`

/**
 * A capacity chart's top: its highest point, up to the next whole subscription (100%), and never
 * past the pool's. A 5-hour chart can never top what the weeks leave, so the pool's full height
 * would flatten it.
 */
export function ceiling(points: Array<[EpochMs, number]>, capacity: number): number {
  const peak = Math.max(0, ...points.map(([, v]) => v))
  return Math.min(capacity, Math.max(1, Math.ceil(peak - 1e-9)))
}

/**
 * What is left of each limit across the pool, from now to the furthest weekly reset, if recent use
 * goes on (the same simulation as the headline), as a share of the whole pool: 100% is every
 * subscription unused. Shaded where no subscription is available.
 */
/** One forecast's charts: what is left of each limit as a share of the pool, and its gaps. */
function capacitySeries(gaps: PoolGaps | null, now: EpochMs, resets: EpochMs[]) {
  if (gaps === null || gaps.trace.length === 0 || gaps.capacity === 0) return null
  const horizonEnd = gaps.trace.at(-1)?.at ?? now
  // The weekly chart to the furthest weekly reset and past it, hourly; the 5-hour one over the
  // next five hours, a window's length, every sample.
  // Half a day past the last reset, so its step up is not on the chart's edge.
  const weeklyUntil = Math.min(horizonEnd, Math.max(now + 24 * HOUR_MS, ...resets) + 12 * HOUR_MS)
  const fiveUntil = Math.min(horizonEnd, now + 5 * HOUR_MS)
  const start = gaps.trace[0]?.at ?? now
  // Every `every` from the first sample, plus the forecast's own sample at its clock, so what is
  // left now reads at now.
  const shown = (at: EpochMs, until: EpochMs, every: number) =>
    at >= now - every && at <= until && ((at - start) % every === 0 || at === gaps.clock)
  const points = (key: 'weekly' | 'fiveHour', until: EpochMs, every: number) =>
    gaps.trace
      .filter((p) => shown(p.at, until, every))
      .map((p): [EpochMs, number] => [p.at, p[key]])
  // Each subscription's share, for the stacked charts.
  // With when each week resets next at each point, for the weekly chart's readout.
  const by = (key: 'weeklyBy' | 'fiveHourBy', until: EpochMs, every: number) => {
    const samples = gaps.trace.filter((p) => shown(p.at, until, every))
    return gaps.subscriptions.map((name, k) => ({
      name,
      points: samples.map((p): [EpochMs, number] => [p.at, p[key][k] ?? 0]),
      weekResets: samples.map((p) => p.weeklyResetsBy[k] ?? null),
    }))
  }
  return {
    weekly: points('weekly', weeklyUntil, HOUR_MS),
    weeklyBy: by('weeklyBy', weeklyUntil, HOUR_MS),
    fiveHour: points('fiveHour', fiveUntil, TRACE_STEP_MS),
    fiveHourBy: by('fiveHourBy', fiveUntil, TRACE_STEP_MS),
    // Out only until a 5-hour window resets, in its own tone: the weeks still have room then.
    bands: gaps.gaps.map((g) => ({
      start: g.start,
      end: g.end ?? horizonEnd,
      ...(g.endsWith === 'fiveHour'
        ? { tone: 'secondary' as const, label: 'None available · 5-hour limits full' }
        : {}),
    })),
    capacity: gaps.capacity,
    subscriptionsShown: gaps.subscriptions,
  }
}

/**
 * What is left of each limit across the pool, from now to the furthest weekly reset, in one
 * subscription's limit (100% each, so five unused subscriptions are 500% and more subscriptions
 * show as more). The weekly chart has two tabs: projected
 * at the recent pace (the same simulation as the headline), and if use stops, when what is left
 * only comes back as limits reset. Shaded where no subscription is available.
 */
export function CapacityOutlook(props: {
  gaps: PoolGaps | null
  /** The same forecast with no more use, for the weekly chart's "If use stops" tab. */
  gapsIfStopped?: PoolGaps | null
  profiles: ProfileStatus[] | null
  now: EpochMs
}) {
  const [weeklyView, setWeeklyView] = useState<'projected' | 'stopped'>('projected')
  // The viewer's clock, once known (the server may not know their zone): reset times wait for it.
  const when = useWhen()
  // Moves on a sample at a time, so the charts redraw when the data does, not every second.
  const now = Math.floor(props.now / TRACE_STEP_MS) * TRACE_STEP_MS
  const resetKey = (props.profiles ?? []).map((p) => p.weekly.resetsAt ?? '').join(',')
  const resets = useMemo(
    () =>
      resetKey
        .split(',')
        .map(Number)
        .filter((t) => t > now),
    [resetKey, now],
  )
  const projected = useMemo(
    () => capacitySeries(props.gaps, now, resets),
    [props.gaps, now, resets],
  )
  const stopped = useMemo(
    () => capacitySeries(props.gapsIfStopped ?? null, now, resets),
    [props.gapsIfStopped, now, resets],
  )
  if (projected === null) return null
  // One toggle for both charts: use going on at the recent pace, or none from now (what is left
  // then only comes back as limits reset).
  const shown = weeklyView === 'stopped' && stopped !== null ? stopped : projected
  // Both charts stacked by subscription, in the colors of the bars: the top is the pool's total,
  // each band one subscription's share. The title carries the total now: the point at or before now.
  const names = (props.profiles ?? []).map((p) => p.profile)
  const short = shortNames(names.length > 0 ? names : shown.subscriptionsShown)
  const colors = accountColors(names.length > 0 ? names : shown.subscriptionsShown)
  const reserves = new Map(
    (props.profiles ?? []).map((p) => [p.profile, p.reserveFraction ?? 0] as const),
  )
  const anyReserve = [...reserves.values()].some((r) => r > 0)
  const chart = (key: 'weekly' | 'fiveHour', title: string, height: number) => {
    const total = shown[key]
    const bySubscription = shown[key === 'weekly' ? 'weeklyBy' : 'fiveHourBy']
    // On the weekly chart, the readout says when each subscription's week resets next after
    // the time read.
    const weekResets = new Map(bySubscription.map((s) => [s.name, s.weekResets]))
    const weekBack = (name: string, index: number) => {
      const at = weekResets.get(name)?.[index] ?? null
      return at === null || when === null ? null : when(at, props.now)
    }
    const current = total.filter(([t]) => t <= props.now).at(-1)?.[1] ?? total[0]?.[1]
    return total.length < 2 ? null : (
      <LineChart
        // In one subscription's limit, said outright: the pool's 66% would read as two thirds of all.
        title={`${title}${current === undefined ? '' : ` · ${asPercent(current)} of one subscription`}`}
        series={bySubscription.map((s) => ({
          key: s.name,
          label: short.get(s.name) ?? s.name,
          color: colors.get(s.name) ?? 'var(--cmd-ink-3)',
          points: s.points,
          // The last part of its week the owner's reserve holds back, hatched.
          ...(key === 'weekly' && (reserves.get(s.name) ?? 0) > 0
            ? { hatchBelow: reserves.get(s.name) ?? 0 }
            : {}),
        }))}
        format={asPercent}
        max={ceiling(total, shown.capacity)}
        bands={shown.bands}
        bandLabel="None available"
        table={false}
        height={height}
        now={now}
        stacked
        // Most left first, and among equals the week that resets soonest.
        rankBy={(name, index) => weekResets.get(name)?.[index] ?? null}
        {...(key === 'weekly' ? { note: weekBack, noteLabel: 'resets' } : {})}
      />
    )
  }
  return (
    <div className="cmd-capacity">
      {stopped !== null && (
        <fieldset className="cmd-segmented cmd-capacity-tabs">
          <legend className="cmd-visually-hidden">Forecast</legend>
          <button
            type="button"
            aria-pressed={weeklyView === 'projected'}
            onClick={() => setWeeklyView('projected')}
          >
            Projected
          </button>
          <button
            type="button"
            aria-pressed={weeklyView === 'stopped'}
            onClick={() => setWeeklyView('stopped')}
          >
            Resets
          </button>
        </fieldset>
      )}
      <div className="cmd-capacity-weekly">{chart('weekly', 'Weekly limit left', 180)}</div>
      {chart('fiveHour', '5-hour limit left, next 5h', 160)}
      <p className="cmd-capacity-note">
        {weeklyView === 'stopped' ? 'With no more use, as limits reset' : 'At the current pace'} ·
        100% is one subscription's whole limit
        {shown.capacity > 1
          ? `, so ${shown.capacity} subscriptions make ${asPercent(shown.capacity)}`
          : ''}{' '}
        · a 5-hour window can use no more than its week has left · shaded: none can take work, red
        until a week resets (or Anthropic's refusal ends), amber until a 5-hour window resets
        {anyReserve ? ' · hatched: the part of a week its reserve holds back from the pool' : ''}
      </p>
    </div>
  )
}

/**
 * The top of the dashboard: when the pool runs out and for how long, the pace that assumes, each
 * subscription's use at a glance, and what is left over time.
 */
/**
 * The capacity advice in words, or null when there is none to give: how many subscriptions to add
 * and by when, or which could be cancelled and after what. `clock` writes a time; without it the
 * line says how long from now.
 */
export function adviceLine(
  advice: CapacityAdvice | null,
  names: ReadonlyMap<string, string>,
  now: EpochMs,
  clock: ((at: EpochMs) => string) | null,
): string | null {
  if (advice === null) return null
  const at = (t: EpochMs) =>
    t <= now + 60_000 ? 'now' : clock === null ? `in ${formatCountdown(t - now)}` : `by ${clock(t)}`
  const target = formatPercent(COVERAGE_TARGET)
  if (advice.kind === 'add') {
    const subs = advice.count === 1 ? '1 subscription' : `${advice.count} subscriptions`
    return `Add ${subs} ${at(advice.buyBy)} for tokens ${target} of the week (${formatPercent(advice.now)} now)`
  }
  if (advice.kind === 'remove') {
    const each = advice.remove.map((r) => {
      const name = names.get(r.profile) ?? r.profile
      if (r.after === null || r.after <= now) return name
      return `${name} ${clock === null ? `in ${formatCountdown(r.after - now)}` : `after ${clock(r.after)}`}`
    })
    const list =
      each.length <= 1 ? each.join('') : `${each.slice(0, -1).join(', ')} and ${each.at(-1)}`
    // The long run: at this pace fewer would do, whatever the next week's resets throw away.
    const cover = advice.of - advice.remove.length
    return `At this pace about ${cover} of ${advice.of} subscriptions cover the work: could cancel ${list}`
  }
  return null
}

/**
 * Which weekly resets throw away the most at the forecast's pace, in words: the two largest, with
 * when; null when nothing is thrown away. `clock` writes a time.
 */
export function unusedLine(
  gaps: PoolGaps | null,
  names: ReadonlyMap<string, string>,
  clock: ((at: EpochMs) => string) | null,
): string | null {
  const lost = gaps?.unusedAtReset ?? []
  if (lost.length === 0) return null
  const largest = [...lost]
    .sort((a, b) => b.unused - a.unused)
    .slice(0, 2)
    .map(
      (r) =>
        `${names.get(r.profile) ?? r.profile} ${formatPercent(r.unused)}${
          clock === null ? '' : ` ${clock(r.at)}`
        }`,
    )
  return `Most wasted: ${largest.join(', ')}`
}

export function PoolOutlook(props: {
  gaps: PoolGaps | null
  /** The same forecast with no more use (poolGaps' noMoreUse), for the weekly chart's other tab. */
  gapsIfStopped?: PoolGaps | null
  profiles: ProfileStatus[] | null
  now: EpochMs
  detail?: string | null
  /** Each subscription's early resets over the last week, for the badges on its cell. */
  earlyResets?: ReadonlyMap<string, EarlyResets> | null
}) {
  const { now } = props
  // No clock times in the banner: the countdowns say it.
  const { tone, headline, facts } = gapsHeadline(props.gaps, now)
  const forecasting =
    props.gaps !== null && props.gaps.lasts !== 'unknown' && props.gaps.lasts !== 'logins'
  // The formula, briefly: the pace carried forward, on the availability line.
  const pace =
    forecasting && props.gaps !== null
      ? `using ${formatPercent(props.gaps.pace.weekly)} of a weekly limit and ${formatPercent(
          props.gaps.pace.fiveHour,
        )} of a 5-hour limit an hour`
      : null
  const status =
    props.detail == null
      ? pace === null
        ? []
        : [pace.charAt(0).toUpperCase() + pace.slice(1)]
      : [pace === null ? props.detail : `${props.detail} · ${pace}`]
  const lines = [...facts, ...status]
  // Fable has its own weekly allowance on each subscription (up to half the week): say what is left.
  const fable = props.profiles === null ? null : fableSummary(props.profiles, now)
  if (fable !== null) {
    lines.push(
      `Fable: ${fable.canTake} of ${fable.withFable} can take it${
        fable.left === null ? '' : ` · ${formatPercent(fable.left)} of their Fable allowance left`
      }`,
    )
  }
  return (
    <section className="cmd-pool" data-tone={tone} aria-labelledby="cmd-pool-headline">
      <div className="cmd-pool-head">
        <svg className="cmd-alert-icon" viewBox="0 0 16 16" aria-hidden="true">
          {TONE_ICON[tone]}
        </svg>
        <div>
          <h2 className="cmd-headline" id="cmd-pool-headline">
            {headline}
          </h2>
          {lines.length > 0 && (
            <ul className="cmd-facts">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
        {props.profiles !== null && (
          <PoolAccounts
            profiles={props.profiles}
            now={now}
            unusedAtReset={props.gaps?.unusedAtReset ?? []}
            earlyResets={props.earlyResets ?? null}
          />
        )}
      </div>
      <CapacityOutlook
        gaps={props.gaps}
        gapsIfStopped={props.gapsIfStopped ?? null}
        profiles={props.profiles}
        now={now}
      />
    </section>
  )
}
