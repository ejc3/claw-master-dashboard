import 'server-only'

import type { MetricsSource } from '@ejc3/claw-master-dashboard'
import {
  ACCESS_ASSERTION_HEADER,
  type AllowlistStore,
  accessOptionsFromEnv,
  cloudflareAccess,
  readAllowlist,
  readConfigValue,
} from '@ejc3/claw-master-dashboard/access'
import {
  ACCOUNT_ALIASES_KEY,
  parseAccountAliases,
  type SourceSelection,
  selectSource,
} from '@ejc3/claw-master-dashboard/cloudwatch'
import { createDemoSource } from '@ejc3/claw-master-dashboard/demo'
import { createResetScenarioSource } from '@ejc3/claw-master-dashboard/demo/reset'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { headers } from 'next/headers'

export const API_BASE = '/api/claw-master'

/** The page's path under /claw-master, from its route's segments. */
export function pagePath(slug: string[] | undefined): string {
  const rest = (slug ?? []).map(encodeURIComponent).join('/')
  return rest === '' ? '/claw-master' : `/claw-master/${rest}`
}

/** The API's address before the rename: pages opened then still poll it. */
export const LEGACY_API_BASE = '/api/claude-master'

let selection: SourceSelection | undefined

// Chosen on first use: on Workers the environment is filled in per request, after module load.
// CloudWatch when the read-only key is set (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION),
// the demo fixture otherwise, and the page says which. The account aliases (accountAliases below)
// fold the account codes of points exported before names into the names. A CloudWatch failure is
// an error on the page, never a quiet switch to demo data.
function selected(): SourceSelection {
  if (selection === undefined) {
    selection = selectSource(process.env, createDemoSource(), { accountAliases })
  }
  return selection
}

export function source(): MetricsSource {
  return selected().source
}

/**
 * The reset scenario, to try the countdown and the return of quota: /claw-master/try-reset, with
 * its API under /api/claw-master/try-reset. Always made-up data, behind the same sign-in.
 */
export const TRY_RESET = 'try-reset'
const scenario = createResetScenarioSource()
export function resetScenarioSource(): MetricsSource {
  return scenario
}

/** True when the page shows the demo fixture, so it can say so. */
export function demoData(): boolean {
  return selected().kind === 'demo'
}

/**
 * Local development without Cloudflare Access: DASHBOARD_AUTH=off admits everyone, and only
 * outside a production build, so it can never open a deployment.
 */
const authDisabled = process.env.NODE_ENV !== 'production' && process.env.DASHBOARD_AUTH === 'off'

declare global {
  interface CloudflareEnv {
    /** The allowlist's and the account aliases' KV namespace (ALLOWLIST_BINDING; docs/deploy.md). */
    DASHBOARD_CONFIG?: AllowlistStore
  }
}

/** The DASHBOARD_CONFIG namespace, or undefined where there is no Worker context (next dev). */
async function configStore(): Promise<AllowlistStore | undefined> {
  try {
    return (await getCloudflareContext({ async: true })).env.DASHBOARD_CONFIG
  } catch {
    return undefined
  }
}

/** How long one reading of the allowlist is used before it is read again. */
const ALLOWLIST_TTL_MS = 60_000

let access:
  | { readAt: number; settings: string; check: ReturnType<typeof cloudflareAccess> | null }
  | undefined

// Read on use and again after ALLOWLIST_TTL_MS: on Workers the environment and bindings are filled
// in per request, after module load, and the allowlist (written by ejc3/aws from the same list as
// the Access policy) changes without a deploy. A removed person is refused within about two
// minutes (KV's own cache plus this one). Without CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD or the KV
// allowlist, with an empty list or with an invalid setting, nobody is admitted (the app fails
// closed) and the reason is logged once per change.
async function accessCheck(): Promise<ReturnType<typeof cloudflareAccess> | null> {
  const now = Date.now()
  if (access !== undefined && now - access.readAt < ALLOWLIST_TTL_MS) return access.check
  const settings = accessOptionsFromEnv(process.env, await readAllowlist(await configStore()))
  // The checker is rebuilt only when a setting changed: it caches the team's signing keys.
  const key = JSON.stringify(settings)
  if (access !== undefined && access.settings === key) {
    access.readAt = now
    return access.check
  }
  let check: ReturnType<typeof cloudflareAccess> | null = null
  if ('missing' in settings) {
    console.error(
      `claw-master dashboard: not set: ${settings.missing.join(', ')}; admitting nobody`,
    )
  } else {
    try {
      check = cloudflareAccess(settings.options)
    } catch (error) {
      console.error(
        'claw-master dashboard: invalid Access settings; admitting nobody:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  access = { readAt: now, settings: key, check }
  return check
}

/** For the route handler: the request must carry a valid Access assertion for this app. */
export async function authorizeRequest(request: Request): Promise<boolean> {
  if (authDisabled) return true
  return (await (await accessCheck())?.authorize(request)) ?? false
}

/** For the page: the same check, on the incoming request's headers. */
export async function authorizePage(): Promise<boolean> {
  if (authDisabled) return true
  const check = await accessCheck()
  if (check === null) return false
  return (await check.identify((await headers()).get(ACCESS_ASSERTION_HEADER))) !== null
}

/** How long one reading of the account aliases is used before it is read again. */
const ALIASES_TTL_MS = 60_000

let aliases: { readAt: number; key: string; map: ReadonlyMap<string, string> } | undefined
/** The cache key while reads fail: never equal to a real one (`missing:...` or `text:...`). */
const READ_FAILED = 'read failed'

// The account aliases come from the DASHBOARD_CONFIG namespace, key account-aliases, which ejc3/aws
// writes from the names claw-master itself uses; read on use and again after ALIASES_TTL_MS, like
// the allowlist. No binding, no key or an empty value means no aliases. A failed read keeps the
// aliases last read (none before the first) and logs the error. Each change of reason is logged
// once, never a name or a code. Exported for its test.
export async function accountAliases(): Promise<ReadonlyMap<string, string>> {
  const now = Date.now()
  if (aliases !== undefined && now - aliases.readAt < ALIASES_TTL_MS) return aliases.map
  const value = await readConfigValue(await configStore(), ACCOUNT_ALIASES_KEY)
  if ('missing' in value && value.cause === 'read') {
    const kept = aliases?.map ?? new Map<string, string>()
    if (aliases?.key !== READ_FAILED) {
      console.warn(
        `claw-master dashboard: account aliases: ${value.missing}${value.error === undefined ? '' : `: ${value.error}`}; ${kept.size === 0 ? 'no aliases' : 'keeping the aliases last read'}`,
      )
    }
    aliases = { readAt: now, key: READ_FAILED, map: kept }
    return kept
  }
  const from = `DASHBOARD_CONFIG/${ACCOUNT_ALIASES_KEY}`
  const key = 'text' in value ? `text:${value.text}` : `missing:${value.missing}`
  if (aliases !== undefined && aliases.key === key) {
    aliases.readAt = now
    return aliases.map
  }
  const map =
    'text' in value
      ? parseAccountAliases(value.text, console.warn, from)
      : new Map<string, string>()
  if ('missing' in value) {
    console.warn(`claw-master dashboard: account aliases: not set: ${value.missing}; no aliases`)
  } else if (map.size === 0) {
    console.warn(`claw-master dashboard: account aliases: ${from} is empty; no aliases`)
  }
  aliases = { readAt: now, key, map }
  return map
}
