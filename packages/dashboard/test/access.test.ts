import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ACCESS_ASSERTION_HEADER,
  ALLOWLIST_BINDING,
  ALLOWLIST_KEY,
  accessOptionsFromEnv,
  accessTeamDomain,
  cloudflareAccess,
  readAllowlist,
  readConfigValue,
} from '../src/access'

const TEAM = 'https://example.cloudflareaccess.com'
const AUD = 'aud-made-up-for-tests'

let sign: (
  claims: Record<string, unknown>,
  options?: { issuer?: string; audience?: string; expiresIn?: string },
) => Promise<string>
let signWithOtherKey: (claims: Record<string, unknown>) => Promise<string>
let jwks: { keys: JWK[] }
let privateKey: CryptoKey

beforeAll(async () => {
  const mine = await generateKeyPair('RS256')
  privateKey = mine.privateKey
  const theirs = await generateKeyPair('RS256')
  jwks = { keys: [{ ...(await exportJWK(mine.publicKey)), kid: 'k1', alg: 'RS256' }] }
  const make =
    (key: CryptoKey) =>
    async (
      claims: Record<string, unknown>,
      o: { issuer?: string; audience?: string; expiresIn?: string } = {},
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(o.issuer ?? TEAM)
        .setAudience(o.audience ?? AUD)
        .setIssuedAt()
        .setExpirationTime(o.expiresIn ?? '5m')
        .sign(key)
  sign = make(mine.privateKey)
  signWithOtherKey = (claims) => make(theirs.privateKey)(claims)
})

function access(extra: { allowedEmails?: string[]; serviceTokenClientId?: string } = {}) {
  return cloudflareAccess({
    teamDomain: `${TEAM}/`,
    audience: AUD,
    allowedEmails: ['owner@example.com'],
    keys: createLocalJWKSet(jwks),
    ...extra,
  })
}

describe('cloudflareAccess', () => {
  it('admits a person Access signed in for this application', async () => {
    const token = await sign({ email: 'Owner@Example.com' })
    expect(await access().identify(token)).toEqual({
      email: 'owner@example.com',
      serviceToken: null,
    })
    const request = new Request('https://dash.example/x', {
      headers: { [ACCESS_ASSERTION_HEADER]: token },
    })
    expect(await access().authorize(request)).toBe(true)
  })

  it('refuses anything Access did not sign for this application', async () => {
    const a = access()
    expect(
      await a.identify(await sign({ email: 'owner@example.com' }, { audience: 'another-app' })),
    ).toBeNull()
    expect(
      await a.identify(
        await sign(
          { email: 'owner@example.com' },
          { issuer: 'https://other.cloudflareaccess.com' },
        ),
      ),
    ).toBeNull()
    expect(
      await a.identify(await sign({ email: 'owner@example.com' }, { expiresIn: '-1m' })),
    ).toBeNull()
    expect(await a.identify(await signWithOtherKey({ email: 'owner@example.com' }))).toBeNull()
    expect(await a.identify('not-a-token')).toBeNull()
    expect(await a.identify(null)).toBeNull()
    expect(await a.authorize(new Request('https://dash.example/x'))).toBe(false)
  })

  it('admits only allowlisted addresses, whatever Access signed', async () => {
    const a = access()
    expect(await a.identify(await sign({ email: 'OWNER@example.com' }))).not.toBeNull()
    // Signed by Access for this application, but not on the app's own list.
    expect(await a.identify(await sign({ email: 'family@example.com' }))).toBeNull()
  })

  it('refuses to start without an allowlist', () => {
    const base = { teamDomain: TEAM, audience: AUD, keys: createLocalJWKSet(jwks) }
    expect(() => cloudflareAccess({ ...base, allowedEmails: [] })).toThrow(/allowlist/)
    expect(() => cloudflareAccess({ ...base, allowedEmails: [' ', ''] })).toThrow(/allowlist/)
    // A caller without types (plain JavaScript) that leaves it out is refused too.
    expect(() =>
      cloudflareAccess(base as unknown as Parameters<typeof cloudflareAccess>[0]),
    ).toThrow(/allowlist is missing/)
  })

  it('admits only the configured service token', async () => {
    const token = await sign({ common_name: 'client-1.access' })
    expect(await access().identify(token)).toBeNull()
    expect(await access({ serviceTokenClientId: 'client-2.access' }).identify(token)).toBeNull()
    expect(await access({ serviceTokenClientId: 'client-1.access' }).identify(token)).toEqual({
      email: null,
      serviceToken: 'client-1.access',
    })
  })

  it('refuses a signed assertion that has no expiry', async () => {
    const forever = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setIssuedAt()
      .sign(privateKey)
    expect(await access().identify(forever)).toBeNull()
  })

  it('takes the team domain only as an https origin, and the audience only when set', () => {
    expect(accessTeamDomain(' https://example.cloudflareaccess.com/\n')).toBe(TEAM)
    expect(() => accessTeamDomain('example.cloudflareaccess.com')).toThrow()
    expect(() => accessTeamDomain('http://example.cloudflareaccess.com')).toThrow()
    expect(() => accessTeamDomain('https://example.cloudflareaccess.com/cdn-cgi')).toThrow()
    expect(() =>
      cloudflareAccess({ teamDomain: TEAM, audience: '  ', allowedEmails: ['owner@example.com'] }),
    ).toThrow()
  })

  it('admits no nameless token when the service token id is blank', async () => {
    const nameless = await sign({ common_name: '' })
    for (const serviceTokenClientId of ['', '  ']) {
      expect(await access({ serviceTokenClientId }).identify(nameless)).toBeNull()
    }
  })

  it('does not fold lookalike characters onto the allowlist', async () => {
    // U+212A KELVIN SIGN lowercases to "k" under Unicode rules.
    const a = access({ allowedEmails: ['kate@example.com'] })
    expect(await a.identify(await sign({ email: '\u212Aate@example.com' }))).toBeNull()
    expect(await a.identify(await sign({ email: 'Kate@Example.com' }))).not.toBeNull()
    // The same on the list's side: a lookalike there matches no real address.
    const lookalike = access({ allowedEmails: ['\u212Aate@example.com'] })
    expect(await lookalike.identify(await sign({ email: 'kate@example.com' }))).toBeNull()
  })

  it('logs a refused address without naming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await access().identify(await sign({ email: 'stranger@example.com' }))).toBeNull()
      const logged = warn.mock.calls.map((c) => c.join(' '))
      expect(logged.some((line) => line.includes('not on the allowlist'))).toBe(true)
      expect(logged.some((line) => line.includes('stranger'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('readAllowlist', () => {
  const store = (values: Record<string, string>) => ({
    get: async (key: string) => values[key] ?? null,
  })

  it('reads the one key Terraform writes', async () => {
    expect(ALLOWLIST_BINDING).toBe('DASHBOARD_CONFIG')
    expect(ALLOWLIST_KEY).toBe('allowed-emails')
    expect(await readAllowlist(store({ 'allowed-emails': 'a@example.com,b@example.com' }))).toEqual(
      { text: 'a@example.com,b@example.com' },
    )
  })

  it('says which part is missing, never a value', async () => {
    expect(await readAllowlist(undefined)).toEqual({ missing: 'DASHBOARD_CONFIG (no KV binding)' })
    expect(await readAllowlist(null)).toEqual({ missing: 'DASHBOARD_CONFIG (no KV binding)' })
    expect(await readAllowlist(store({ other: 'a@example.com' }))).toEqual({
      missing: 'DASHBOARD_CONFIG/allowed-emails (no such key)',
    })
    const failing = {
      get: async (): Promise<string | null> => {
        throw new Error('a@example.com unreachable')
      },
    }
    expect(await readAllowlist(failing)).toEqual({
      missing: 'DASHBOARD_CONFIG/allowed-emails (read failed)',
    })
  })
})

describe('readConfigValue', () => {
  it('reads any key of the namespace with the same reasons', async () => {
    const store = { get: async (key: string) => (key === 'account-aliases' ? 'x' : null) }
    expect(await readConfigValue(store, 'account-aliases')).toEqual({ text: 'x' })
    expect(await readConfigValue(store, 'other')).toEqual({
      missing: 'DASHBOARD_CONFIG/other (no such key)',
    })
    expect(await readConfigValue(undefined, 'account-aliases')).toEqual({
      missing: 'DASHBOARD_CONFIG (no KV binding)',
    })
  })
})

describe('accessOptionsFromEnv', () => {
  const list = (text: string) => ({ text })

  it('names each missing setting, never a value', () => {
    expect(accessOptionsFromEnv({}, { missing: 'DASHBOARD_CONFIG (no KV binding)' })).toEqual({
      missing: ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'DASHBOARD_CONFIG (no KV binding)'],
    })
    expect(
      accessOptionsFromEnv({ CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }, list(' , ')),
    ).toEqual({ missing: ['DASHBOARD_CONFIG/allowed-emails (empty)'] })
    expect(
      accessOptionsFromEnv({ CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }, list('')),
    ).toEqual({ missing: ['DASHBOARD_CONFIG/allowed-emails (empty)'] })
  })

  it('ignores the retired DASHBOARD_ALLOWED_EMAILS secret: the KV list is the only one', () => {
    expect(
      accessOptionsFromEnv(
        {
          CF_ACCESS_TEAM_DOMAIN: TEAM,
          CF_ACCESS_AUD: AUD,
          DASHBOARD_ALLOWED_EMAILS: 'a@example.com',
        },
        { missing: 'DASHBOARD_CONFIG/allowed-emails (no such key)' },
      ),
    ).toEqual({ missing: ['DASHBOARD_CONFIG/allowed-emails (no such key)'] })
  })

  it('splits the allowlist on commas and whitespace and drops a blank service token', () => {
    expect(
      accessOptionsFromEnv(
        {
          CF_ACCESS_TEAM_DOMAIN: ` ${TEAM} `,
          CF_ACCESS_AUD: AUD,
          DASHBOARD_SERVICE_TOKEN_CLIENT_ID: '  ',
        },
        list('a@example.com b@example.com,\nc@example.com,'),
      ),
    ).toEqual({
      options: {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ['a@example.com', 'b@example.com', 'c@example.com'],
      },
    })
  })
})
