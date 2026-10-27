'use client'

import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type AlarmStatus,
  type EpochMs,
  fillSeries,
  formatWhen,
  type Series,
  type SeriesQuery,
  type Snapshot,
  TIME_ZONE_COOKIE,
  type TimeRange,
} from '../core'
import type { PollFailure, PollState } from './poller'
import { createPollStore, type PollStore, PollStoreContext } from './pollStore'
import { type FirstSeries, queryKey, queryShape } from './queries'

/**
 * What the server rendered the page with: the answers to its first queries, and the viewer's
 * time zone when the browser has told it (a cookie). The first render in the browser uses the
 * same, so hydrating the page changes nothing on screen.
 */
export interface FirstPaint {
  series: FirstSeries
  timeZone: string | null
}

export const FirstPaintContext = createContext<FirstPaint>({ series: {}, timeZone: null })

/** The element's content width, tracked as it resizes; 0 before the first measurement. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/**
 * Holds an element at the height it last had while not loading, for as long as `loading` is
 * true: switching a view swaps its content for a loading note without the panel shrinking and
 * the page jumping. The first load holds nothing (there is no height yet).
 */
export function useHeldHeight<T extends HTMLElement>(
  loading: boolean,
): [RefObject<T | null>, number | undefined] {
  const ref = useRef<T>(null)
  const last = useRef<number | undefined>(undefined)
  // Measured after each render that shows content, before the browser paints.
  useLayoutEffect(() => {
    if (!loading && ref.current !== null) last.current = ref.current.offsetHeight
  })
  return [ref, loading ? last.current : undefined]
}

/** True while the page is shown; polling stops while it is hidden. */
export function useVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

const noSubscribe = () => () => {}

/** False during server rendering and hydration, true after. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
}

/**
 * Formats a wall-clock time for the viewer, or null while the time zone is unknown. The server
 * and the hydrating render use the zone the browser reported last time (the same one, unless the
 * viewer has moved); after hydration the browser's own zone applies.
 */
export function useWhen(): ((at: EpochMs, now: EpochMs) => string) | null {
  const { timeZone } = useContext(FirstPaintContext)
  if (useHydrated()) return (at, now) => formatWhen(at, now)
  return timeZone === null ? null : (at, now) => formatWhen(at, now, timeZone)
}

/** Tells the server the viewer's time zone (a cookie) when it does not know it yet. */
export function useReportTimeZone(): void {
  const { timeZone } = useContext(FirstPaintContext)
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (zone === timeZone) return
    const secure = window.location.protocol === 'https:' ? '; secure' : ''
    // biome-ignore lint/suspicious/noDocumentCookie: one non-secret preference, read by the server
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax${secure}`
  }, [timeZone])
}

/** The current time, advancing every `everyMs` while the page is visible. */
export function useNow(everyMs: number, initial: EpochMs): EpochMs {
  const [now, setNow] = useState(initial)
  const visible = useVisible()
  // A browser clock behind the server's would move every range back a step on hydrating, and the
  // server's answers would no longer match. So the time is never earlier than `initial` plus the
  // time since the page started (a monotonic clock), and follows the browser's clock once that
  // is later, as after the browser corrects it.
  const start = useRef<{ at: EpochMs; mono: number } | null>(null)
  useEffect(() => {
    if (!visible) return
    start.current ??= { at: initial, mono: performance.now() }
    const read = () => {
      const since = start.current
      return since === null
        ? Date.now()
        : Math.max(Date.now(), since.at + (performance.now() - since.mono))
    }
    setNow(read())
    const timer = setInterval(() => setNow(read()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs, visible, initial])
  return now
}

export type Loaded<T> =
  | { state: 'loading' }
  | {
      state: 'ready'
      data: T
      at: EpochMs
      failure: PollFailure | null
      /** For series: the range the data answers, which is the query's own, or an earlier one's. */
      range?: TimeRange
    }
  | { state: 'error'; failure: PollFailure }

/** Polls `url` while visible. Data from another URL never shows under this one. */
function usePolled<T>(url: string | null, everyMs: number, initial?: T): Loaded<T> {
  const shared = useContext(PollStoreContext)
  const [own] = useState(() => (shared === null ? createPollStore() : null))
  const store = (shared ?? own) as PollStore
  // The server rendered `initial`, so the first request waits one period.
  if (url !== null && initial !== undefined) store.seed(url, initial, Date.now())
  const visible = useVisible()
  const subscribe = useCallback(
    (onChange: () => void) =>
      url === null ? () => {} : store.subscribe(url, onChange, visible ? everyMs : undefined),
    [store, url, everyMs, visible],
  )
  const read = () => (url === null ? undefined : store.get(url))
  const poll = useSyncExternalStore(subscribe, read, read) as PollState<T> | undefined

  if (poll === undefined || poll.url !== url) return { state: 'loading' }
  if (poll.data !== undefined) {
    return { state: 'ready', data: poll.data, at: poll.at ?? 0, failure: poll.failure ?? null }
  }
  return poll.failure === undefined
    ? { state: 'loading' }
    : { state: 'error', failure: poll.failure }
}

/** How long the background queue waits for one URL's answer before starting the next. */
export const PREFETCH_PATIENCE_MS = 15_000

/**
 * Keeps `urls` loaded and polled in the background while the page is shown, starting them one at
 * a time in order: the next starts when the one before has answered (or failed), so what is on
 * screen is never queued behind them. Nothing new starts until `enabled`. A URL stays held while
 * it is in `urls`, so a reordered list (another range shown first) keeps what was loaded. While
 * the page is hidden the held answers are kept but not polled.
 */
export function usePrefetch(urls: readonly string[], everyMs: number, enabled: boolean): void {
  const store = useContext(PollStoreContext)
  const visible = useVisible()
  const held = useRef(new Map<string, { off: () => void; polled: boolean }>())
  const key = urls.join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: urls are read through their key
  useEffect(() => {
    if (store === null) return
    const want = new Set(urls)
    for (const [url, h] of held.current) {
      if (!want.has(url)) {
        h.off()
        held.current.delete(url)
      }
    }
    // Subscribe anew before letting go of the old subscription, so the answer is never dropped.
    const hold = (url: string, polled: boolean, listener: () => void) => {
      const previous = held.current.get(url)
      held.current.set(url, {
        off: store.subscribe(url, listener, polled ? everyMs : undefined),
        polled,
      })
      previous?.off()
    }
    if (!visible) {
      for (const [url, h] of held.current) if (h.polled) hold(url, false, () => {})
      return
    }
    if (!enabled) return
    let stopped = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const queue = urls.filter((url) => held.current.get(url)?.polled !== true)
    const next = () => {
      if (stopped) return
      const url = queue.shift()
      if (url === undefined) return
      // Something already polls it (the view on screen): nothing to wait for.
      if (store.polling(url)) {
        hold(url, true, () => {})
        next()
        return
      }
      // Otherwise wait for this poll's own answer, even where an older one is kept (held while
      // hidden), so the polls start one after another; a URL that does not answer is left to
      // its poller after PREFETCH_PATIENCE_MS.
      const before = store.get(url)
      let started = false
      const go = () => {
        if (started) return
        started = true
        clearTimeout(patience)
        next()
      }
      const patience = setTimeout(go, PREFETCH_PATIENCE_MS)
      timers.add(patience)
      const answered = () => {
        const state = store.get(url)
        if (state === undefined || state === before) return
        if (state.data !== undefined || state.failure !== undefined) go()
      }
      hold(url, true, answered)
    }
    // After this render's other effects (React runs them together), so a URL the page itself
    // polls is seen as polled rather than waited on: a seeded one would not answer for a period.
    queueMicrotask(next)
    return () => {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
    }
  }, [store, key, everyMs, enabled, visible])
  useEffect(
    () => () => {
      for (const h of held.current.values()) h.off()
      held.current.clear()
    },
    [],
  )
}

/** claude-master's alarms, read once a minute. */
export function useAlarms(apiBase: string, initial: AlarmStatus[] | null): Loaded<AlarmStatus[]> {
  return usePolled<AlarmStatus[]>(`${apiBase}/alarms`, 60_000, initial ?? undefined)
}

export function useSnapshot(apiBase: string, initial: Snapshot | null): Loaded<Snapshot> {
  return usePolled<Snapshot>(`${apiBase}/snapshot`, 60_000, initial ?? undefined)
}

type Kept<T> = { shape: string; end: EpochMs; loaded: Loaded<T> } | null

/**
 * The last answer stays on show while the same query, its range moved on by one step, loads: the
 * range moves every few minutes, and nothing should blank while it does. The answer carries the
 * range it covers (`range`), so what is computed from it uses that range, not the new one. A
 * different query (a new range or split), or a range that moved further (a page hidden for a
 * while), shows as loading: an old answer never passes for another query's or for the present.
 */
export function keepWhileLoading<T>(
  kept: { current: Kept<T> },
  query: SeriesQuery,
  loaded: Loaded<T>,
): Loaded<T> {
  const shape = queryShape(query)
  if (loaded.state === 'ready') {
    const answered = { ...loaded, range: query.range }
    kept.current = { shape, end: query.range.end, loaded: answered }
    return answered
  }
  const moved = query.range.end - (kept.current?.end ?? Number.NaN)
  if (
    loaded.state === 'loading' &&
    kept.current?.shape === shape &&
    moved > 0 &&
    moved <= query.stepSeconds * 1000
  ) {
    return kept.current.loaded
  }
  return loaded
}

/** How often a series is fetched again. */
export const SERIES_POLL_MS = 5 * 60_000

function useSeriesPoll(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const { series } = useContext(FirstPaintContext)
  const key = query === null ? null : queryKey(query)
  const url = key === null ? null : `${apiBase}/series?${key}`
  return usePolled<Series[]>(url, SERIES_POLL_MS, key === null ? undefined : series[key])
}

/** Series for `query`, filled onto its step grid so a missing bucket counts as zero. */
export function useSeries(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const loaded = useSeriesPoll(apiBase, query)
  const filled = useRef<{ from: Series[]; to: Series[] } | null>(null)
  const kept = useRef<Kept<Series[]>>(null)
  if (query === null) return loaded
  if (loaded.state !== 'ready') return keepWhileLoading(kept, query, loaded)
  if (filled.current?.from !== loaded.data) {
    filled.current = { from: loaded.data, to: fillSeries(loaded.data, query) }
  }
  return keepWhileLoading(kept, query, { ...loaded, data: filled.current.to })
}

/**
 * Readings of a gauge for `query`, as the source returned them: a missing bucket stays missing,
 * because a zero would read as a reset.
 */
export function useReadings(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const loaded = useSeriesPoll(apiBase, query)
  const kept = useRef<Kept<Series[]>>(null)
  return query === null ? loaded : keepWhileLoading(kept, query, loaded)
}

/**
 * Series for `query` filled onto its step grid, plus when the raw data starts: the earliest point
 * the source returned, before filling turns missing buckets into zeros. The token charts use it
 * to tell "no tokens counted yet" from "no traffic".
 */
export function useCountedSeries(
  apiBase: string,
  query: SeriesQuery | null,
): { loaded: Loaded<Series[]>; firstAt: EpochMs | null } {
  const raw = useReadings(apiBase, query)
  const filled = useRef<{ from: Series[]; to: Series[]; firstAt: EpochMs | null } | null>(null)
  if (raw.state !== 'ready' || query === null) return { loaded: raw, firstAt: null }
  if (filled.current?.from !== raw.data) {
    let firstAt: EpochMs | null = null
    for (const s of raw.data)
      for (const [t] of s.points) if (firstAt === null || t < firstAt) firstAt = t
    filled.current = { from: raw.data, to: fillSeries(raw.data, query), firstAt }
  }
  return { loaded: { ...raw, data: filled.current.to }, firstAt: filled.current.firstAt }
}

/**
 * The newest data a query has delivered, kept while a changed query loads or fails, so what
 * depends on it does not drop to a fallback every time its range moves on.
 */
export function lastReady<T>(previous: T | null, loaded: Loaded<T>): T | null {
  return loaded.state === 'ready' ? loaded.data : previous
}

export function useLastReady<T>(loaded: Loaded<T>): T | null {
  const kept = useRef<T | null>(null)
  kept.current = lastReady(kept.current, loaded)
  return kept.current
}
