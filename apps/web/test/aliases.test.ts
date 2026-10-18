import { afterAll, describe, expect, it, vi } from 'vitest'

// The account aliases come from the DASHBOARD_CONFIG namespace, key account-aliases. The
// DASHBOARD_ACCOUNT_ALIASES secret is read only on a definite "no such key"; once the key exists,
// the KV value is the only source and an empty one means no aliases. A failed read keeps the
// aliases last read (none before the first) and never falls back. A change is picked up after the
// app's cache runs out, and nothing logged names a person or a code.

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
  delete process.env.DASHBOARD_ACCOUNT_ALIASES
})

describe('the account aliases from KV', () => {
  it('reads KV, falls back to the old secret only while the key is missing, and rereads after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date())
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { accountAliases } = await import('../lib/dashboard')
    const later = () => vi.setSystemTime(Date.now() + 61_000)
    const logged = () => warns.mock.calls.map((c) => c.join(' '))
    const entries = async () => [...(await accountAliases())]

    try {
      // Nothing anywhere: no aliases, and the log says why.
      expect(await entries()).toEqual([])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: not set: DASHBOARD_CONFIG (no KV binding); no aliases',
      )

      // Without the binding the old secret is not read either: only a missing key falls back.
      process.env.DASHBOARD_ACCOUNT_ALIASES = 'acct-0000aaaa=alpha'
      later()
      expect(await entries()).toEqual([])

      // A failed read is not a missing key: no fallback, nothing read yet, and the error logged.
      kv.bound = true
      kv.failing = true
      later()
      expect(await entries()).toEqual([])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: DASHBOARD_CONFIG/account-aliases (read failed): KV unavailable; no aliases',
      )

      // The old secret, while KV definitely has no key.
      kv.failing = false
      later()
      expect(await entries()).toEqual([['acct-0000aaaa', 'alpha']])
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: account aliases: not set: DASHBOARD_CONFIG/account-aliases (no such key); using DASHBOARD_ACCOUNT_ALIASES until it is',
      )

      // The key exists: it wins, and the old secret is ignored.
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

      // An empty value (only the header) means no aliases, not the old secret.
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
      for (const secret of ['alpha', 'bravo', 'charlie', 'delta', 'acct-0000']) {
        expect(all).not.toContain(secret)
      }
    } finally {
      warns.mockRestore()
    }
  })
})
