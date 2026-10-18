import { afterAll, describe, expect, it, vi } from 'vitest'

// The account aliases come from the DASHBOARD_CONFIG namespace, key account-aliases, and nowhere
// else: no binding, no key or an empty value means no aliases. A failed read keeps the aliases last
// read (none before the first). A change is picked up after the app's cache runs out, and nothing
// logged names a person or a code.

const kv: { bound: boolean; failing: boolean; values: Record<string, string> } = {
  bound: false,
  failing: false,
  values: {},
}

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: async () => ({
    env: kv.bound
      ? {
          DASHBOARD_CONFIG: {
            get: async (key: string) => {
              if (kv.failing) throw new Error('KV unavailable')
              return kv.values[key] ?? null
            },
          },
        }
      : {},
  }),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

afterAll(() => {
  vi.useRealTimers()
})

describe('the account aliases from KV', () => {
  it('reads only the KV key, keeps the last aliases through a failed read, and rereads after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date())
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { accountAliases } = await import('../lib/dashboard')
    const later = () => vi.setSystemTime(Date.now() + 61_000)
    const logged = () => warns.mock.calls.map((c) => c.join(' '))
    const entries = async () => [...(await accountAliases())]

    try {
      // No binding: no aliases, and the log says why.
      expect(await entries()).toEqual([])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: not set: DASHBOARD_CONFIG (no KV binding); no aliases',
      )

      // No key: no aliases.
      kv.bound = true
      later()
      expect(await entries()).toEqual([])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: not set: DASHBOARD_CONFIG/account-aliases (no such key); no aliases',
      )

      // A failed read before any good one: none, and the error logged.
      kv.failing = true
      later()
      expect(await entries()).toEqual([])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: DASHBOARD_CONFIG/account-aliases (read failed): KV unavailable; no aliases',
      )

      // The key.
      kv.failing = false
      kv.values['account-aliases'] =
        '# written by Terraform\nacct-0000bbbb=bravo\nacct-0000cccc=charlie'
      later()
      expect(await entries()).toEqual([
        ['acct-0000bbbb', 'bravo'],
        ['acct-0000cccc', 'charlie'],
      ])

      // A failed read keeps the aliases last read, logged once while it lasts.
      kv.failing = true
      later()
      const failures = logged().length
      expect(await entries()).toHaveLength(2)
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: DASHBOARD_CONFIG/account-aliases (read failed): KV unavailable; keeping the aliases last read',
      )
      later()
      expect(await entries()).toHaveLength(2)
      expect(logged().length).toBe(failures + 1)
      kv.failing = false
      later()
      expect(await entries()).toHaveLength(2)

      // A change waits for the cache to run out.
      kv.values['account-aliases'] = '# written by Terraform\nacct-0000bbbb=bravo'
      expect(await entries()).toHaveLength(2)
      later()
      expect(await entries()).toEqual([['acct-0000bbbb', 'bravo']])

      // An empty value (only the header) means no aliases.
      kv.values['account-aliases'] = '# written by Terraform'
      later()
      expect(await entries()).toEqual([])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: DASHBOARD_CONFIG/account-aliases is empty; no aliases',
      )

      // Malformed lines are counted against the KV key, never shown.
      kv.values['account-aliases'] = 'acct-0000bbbb=bravo\nnot-a-code=delta'
      later()
      expect(await entries()).toEqual([['acct-0000bbbb', 'bravo']])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: 1 malformed line in DASHBOARD_CONFIG/account-aliases ignored',
      )

      const all = logged().join('\n')
      for (const secret of ['bravo', 'charlie', 'delta', 'acct-0000']) {
        expect(all).not.toContain(secret)
      }
    } finally {
      warns.mockRestore()
    }
  })
})
