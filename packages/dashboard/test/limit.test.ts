import { describe, expect, it } from 'vitest'
import { createCloudWatchSource, SNAPSHOT_QUERIES_AT_ONCE } from '../src/cloudwatch/index'
import { inTurn } from '../src/core/index'
import { limitRequests } from '../src/react/pollStore'

/** A task that waits until let go, counting how many run at once. */
function gate() {
  let running = 0
  let most = 0
  const started: string[] = []
  const waiting = new Map<string, () => void>()
  const task =
    (name: string, fail = false) =>
    async () => {
      running++
      most = Math.max(most, running)
      started.push(name)
      await new Promise<void>((resolve) => waiting.set(name, resolve))
      running--
      if (fail) throw new Error(name)
      return name
    }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const release = async (name: string) => {
    waiting.get(name)?.()
    await flush()
  }
  return { task, release, flush, started, most: () => most }
}

describe('inTurn', () => {
  it('runs at most its number at once, the rest in order as each ends, failed or not', async () => {
    const g = gate()
    const turn = inTurn(2)
    const results = ['a', 'b', 'c', 'd'].map((n) =>
      turn(g.task(n, n === 'a')).catch(() => 'failed'),
    )
    await g.flush()
    expect(g.started).toEqual(['a', 'b'])
    await g.release('a')
    expect(g.started).toEqual(['a', 'b', 'c'])
    await g.release('b')
    await g.release('c')
    await g.release('d')
    expect(await Promise.all(results)).toEqual(['failed', 'b', 'c', 'd'])
    expect(g.most()).toBe(2)
  })
})

describe('limitRequests', () => {
  it('keeps at most its number in flight, and drops one cancelled while it waits', async () => {
    const asked: string[] = []
    const answers = new Map<string, () => void>()
    const limited = limitRequests(async (url) => {
      asked.push(url)
      await new Promise<void>((resolve) => answers.set(url, resolve))
      return new Response(url)
    }, 2)
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const cancel = new AbortController()
    const requests = ['/a', '/b', '/c', '/d'].map((url) =>
      limited(url, url === '/c' ? { signal: cancel.signal } : {}).then(
        (r) => r.text(),
        (e: unknown) => (e as Error).name,
      ),
    )
    await flush()
    expect(asked).toEqual(['/a', '/b'])
    cancel.abort()
    answers.get('/a')?.()
    await flush()
    // /c was cancelled in line: /d takes the free slot.
    expect(asked).toEqual(['/a', '/b', '/d'])
    answers.get('/b')?.()
    answers.get('/d')?.()
    expect(await Promise.all(requests)).toEqual(['/a', '/b', 'AbortError', '/d'])
  })
})

describe("the snapshot's queries", () => {
  it(`run ${SNAPSHOT_QUERIES_AT_ONCE} at a time`, async () => {
    let running = 0
    let most = 0
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      now: () => Date.UTC(2026, 9, 10, 6),
      fetch: (async () => {
        running++
        most = Math.max(most, running)
        await new Promise((resolve) => setTimeout(resolve, 1))
        running--
        return Response.json({ MetricDataResults: [] })
      }) as unknown as typeof fetch,
    })
    await src.snapshot()
    expect(most).toBe(SNAPSHOT_QUERIES_AT_ONCE)
  })
})
