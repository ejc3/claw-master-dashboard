import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The reference app's allowlist comes from the DASHBOARD_CONFIG KV namespace, never from a Worker
// secret: no binding, no key or an empty list admits nobody and logs which; a changed list takes
// effect after the app's cache runs out.

const TEAM = 'https://example.cloudflareaccess.com'
const AUD = 'aud-made-up-for-tests'

const kv: { value: string | null; bound: boolean } = { value: null, bound: false }

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: async () => ({
    env: kv.bound ? { DASHBOARD_CONFIG: { get: async () => kv.value } } : {},
  }),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const text = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

let sign: (email: string) => Promise<string>

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256' }
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url) !== `${TEAM}/cdn-cgi/access/certs`) throw new Error('unexpected fetch')
    return Response.json({ keys: [jwk] })
  })
  sign = async (email) => {
    const now = Math.floor(Date.now() / 1000)
    const body = `${text({ alg: 'RS256', kid: 'k1' })}.${text({ email, iss: TEAM, aud: AUD, iat: now, exp: now + 3600 })}`
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(body),
    )
    return `${body}.${b64url(new Uint8Array(signature))}`
  }
  process.env.CF_ACCESS_TEAM_DOMAIN = TEAM
  process.env.CF_ACCESS_AUD = AUD
  // The secret this replaces: it must admit no one.
  process.env.DASHBOARD_ALLOWED_EMAILS = 'retired@example.com'
  delete process.env.DASHBOARD_AUTH
})

afterAll(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.DASHBOARD_ALLOWED_EMAILS
})

describe('the allowlist from KV', () => {
  it('admits by the KV list only, logs what is missing, and rereads it after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date())
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { authorizeRequest } = await import('../lib/dashboard')
    const asks = async (email: string) =>
      authorizeRequest(
        new Request('https://dash.example.com/api/claw-master/snapshot', {
          headers: { 'cf-access-jwt-assertion': await sign(email) },
        }),
      )
    const later = () => vi.setSystemTime(Date.now() + 61_000)
    const logged = () => errors.mock.calls.map((c) => c.join(' '))

    try {
      // No binding: nobody, not even the address in the retired secret.
      expect(await asks('retired@example.com')).toBe(false)
      expect(logged().at(-1)).toBe(
        'claw-master dashboard: not set: DASHBOARD_CONFIG (no KV binding); admitting nobody',
      )

      kv.bound = true
      later()
      expect(await asks('retired@example.com')).toBe(false)
      expect(logged().at(-1)).toContain('DASHBOARD_CONFIG/allowed-emails (no such key)')

      kv.value = ' , '
      later()
      expect(await asks('a@example.com')).toBe(false)
      expect(logged().at(-1)).toContain('DASHBOARD_CONFIG/allowed-emails (empty)')

      kv.value = 'a@example.com,b@example.com'
      later()
      expect(await asks('a@example.com')).toBe(true)
      expect(await asks('retired@example.com')).toBe(false)

      // A removal takes effect when the cache runs out, not before.
      kv.value = 'b@example.com'
      expect(await asks('a@example.com')).toBe(true)
      later()
      expect(await asks('a@example.com')).toBe(false)
      expect(await asks('b@example.com')).toBe(true)

      // Nothing logged ever names an address.
      const all = [...logged(), ...warns.mock.calls.map((c) => c.join(' '))]
      expect(all.some((line) => line.includes('@'))).toBe(false)
    } finally {
      errors.mockRestore()
      warns.mockRestore()
    }
  })
})
