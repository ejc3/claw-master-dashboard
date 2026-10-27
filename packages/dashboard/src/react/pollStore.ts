import { createContext } from 'react'
import { type PollState, startPoller } from './poller'

type Listener = () => void

interface Entry {
  state: PollState<unknown> | undefined
  listeners: Set<Listener>
  /** Readers that want the URL polled; the poller runs while there is at least one. */
  pollers: number
  everyMs: number
  /** Seeded from the server render and not fetched since: the first request waits a period. */
  seeded: boolean
  stop: (() => void) | null
}

/**
 * One poller per URL, shared by every reader of it. A URL loaded in the background (another tab,
 * another range) stays polled for as long as something asks for it, so the view that shows it
 * later has its answer at once. A URL nothing reads or polls any more is forgotten.
 */
export interface PollStore {
  get(url: string): PollState<unknown> | undefined
  /** Records the server-rendered answer for `url`, unless the store already has one. */
  seed(url: string, data: unknown, at: number): void
  /** Calls `listener` on every change to `url`; with `everyMs`, also keeps `url` polled. */
  subscribe(url: string, listener: Listener, everyMs?: number): () => void
  /** Whether something is polling `url` now. */
  polling(url: string): boolean
}

export function createPollStore(
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): PollStore {
  const entries = new Map<string, Entry>()
  const entry = (url: string): Entry => {
    let e = entries.get(url)
    if (e === undefined) {
      e = {
        state: undefined,
        listeners: new Set(),
        pollers: 0,
        everyMs: 0,
        seeded: false,
        stop: null,
      }
      entries.set(url, e)
    }
    return e
  }
  const release = (url: string, e: Entry) => {
    // Nothing reads the URL and nothing polls it: forget it, so moved ranges do not pile up. Not
    // at once: React swaps a subscription by unsubscribing first, within the same update.
    queueMicrotask(() => {
      if (entries.get(url) === e && e.listeners.size === 0 && e.pollers === 0) entries.delete(url)
    })
  }
  return {
    get: (url) => entries.get(url)?.state,
    polling: (url) => (entries.get(url)?.stop ?? null) !== null,
    seed(url, data, at) {
      const e = entry(url)
      if (e.state !== undefined) return
      e.state = { url, data, at }
      e.seeded = true
    },
    subscribe(url, listener, everyMs) {
      const e = entry(url)
      e.listeners.add(listener)
      if (everyMs !== undefined) {
        e.pollers++
        if (e.stop === null) {
          e.everyMs = everyMs
          const delayFirst = e.seeded
          e.seeded = false
          e.stop = startPoller<unknown>({
            url,
            everyMs,
            delayFirst,
            fetch: fetchFn,
            previous: e.state,
            onChange: (state) => {
              e.state = state
              for (const l of [...e.listeners]) l()
            },
          })
        }
      }
      return () => {
        e.listeners.delete(listener)
        if (everyMs !== undefined) {
          e.pollers--
          if (e.pollers === 0 && e.stop !== null) {
            e.stop()
            e.stop = null
          }
        }
        release(url, e)
      }
    },
  }
}

/** How many of the page's requests are in flight at once: each is a CloudWatch query or more. */
export const MAX_REQUESTS_IN_FLIGHT = 4

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/**
 * `fetchFn` with at most `max` requests in flight; the rest wait their turn in order, and one
 * cancelled while it waits is dropped from the line. CloudWatch runs ten Metrics Insights queries
 * a second for the whole account, and a page asks for dozens at once.
 */
export function limitRequests(fetchFn: FetchFn, max: number): FetchFn {
  let running = 0
  const waiting: Array<() => void> = []
  return async (url, init) => {
    if (running < max) running++
    else {
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal
        const go = () => {
          signal?.removeEventListener('abort', cancel)
          resolve()
        }
        const cancel = () => {
          const at = waiting.indexOf(go)
          if (at >= 0) waiting.splice(at, 1)
          reject(signal?.reason ?? new DOMException('The request was cancelled.', 'AbortError'))
        }
        if (signal?.aborted) return cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        waiting.push(go)
      })
    }
    // The slot passes straight to the next in line when this one ends.
    try {
      return await fetchFn(url, init)
    } finally {
      const next = waiting.shift()
      if (next === undefined) running--
      else next()
    }
  }
}

/** The page's shared store; null outside a dashboard, where each reader polls on its own. */
export const PollStoreContext = createContext<PollStore | null>(null)
