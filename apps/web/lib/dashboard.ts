import 'server-only'

import type { MetricsSource } from '@ejc3/claw-master-dashboard'
import {
  ACCESS_ASSERTION_HEADER,
  type AllowlistStore,
  accessOptionsFromEnv,
  cloudflareAccess,
  readAllowlist,
} from '@ejc3/claw-master-dashboard/access'
import { type SourceSelection, selectSource } from '@ejc3/claw-master-dashboard/cloudwatch'
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
// the demo fixture otherwise, and the page says which. DASHBOARD_ACCOUNT_ALIASES, read from the
// same environment, folds the account codes of points exported before names into the names. A CloudWatch failure is an error on the
// page, never a quiet switch to demo data.
function selected(): SourceSelection {
  if (selection === undefined) selection = selectSource(process.env, createDemoSource())
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
    /** The allowlist's KV namespace (ALLOWLIST_BINDING; docs/deploy.md). */
    DASHBOARD_CONFIG?: AllowlistStore
  }
}

/** The allowlist's KV namespace, or undefined where there is no Worker context (next dev). */
async function allowlistStore(): Promise<AllowlistStore | undefined> {
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
  const settings = accessOptionsFromEnv(process.env, await readAllowlist(await allowlistStore()))
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
