import { readFileSync } from 'node:fs'
import { ALLOWLIST_BINDING } from '@ejc3/claw-master-dashboard/access'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('the deployed Worker', () => {
  it('is claw-master-dashboard only, with its URL on', () => {
    // JSONC: drop the comments before parsing.
    const config = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''))
    expect(config.name).toBe('claw-master-dashboard')
    expect(config.workers_dev).toBe(true)
    expect(config.preview_urls).toBe(false)
    // One Worker: no environment deploys another name, and nothing redirects elsewhere.
    expect(config.env).toBeUndefined()
    expect(config.vars).toBeUndefined()
  })

  it('binds the allowlist namespace, whose real id only the Deploy workflow puts in', () => {
    const config = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''))
    const placeholder = '0'.repeat(32)
    expect(config.kv_namespaces).toEqual([{ binding: ALLOWLIST_BINDING, id: placeholder }])

    const deploy = read('../../.github/workflows/deploy.yml')
    const step = deploy.slice(deploy.indexOf('- name: Deploy claw-master-dashboard'))
    expect(step).toMatch(/DASHBOARD_CONFIG_KV_ID: \$\{\{ vars\.DASHBOARD_CONFIG_KV_ID \}\}/)
    expect(step).toContain(`placeholder=${placeholder}`)
    // The id is checked and substituted before the deploy, which never runs with the placeholder.
    const check = step.indexOf("grep -Eqx '[0-9a-f]{32}'")
    const substitute = step.indexOf('sed -i "s/\\"id\\": \\"$placeholder\\"/')
    const confirm = step.indexOf('grep -q "\\"id\\": \\"$DASHBOARD_CONFIG_KV_ID\\"" wrangler.jsonc')
    const run = step.indexOf('pnpm exec wrangler deploy')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(substitute)
    expect(substitute).toBeLessThan(confirm)
    expect(confirm).toBeLessThan(run)
  })

  it('deletes the retired Worker only once its URL is off', () => {
    const deploy = read('../../.github/workflows/deploy.yml')
    expect(deploy).not.toMatch(/wrangler deploy --env/)
    const step = deploy.slice(deploy.indexOf('- name: Delete the retired claude-master-dashboard'))
    expect(step.indexOf('.result.enabled or .result.previews_enabled')).toBeGreaterThan(-1)
    expect(step.indexOf('.result.enabled or .result.previews_enabled')).toBeLessThan(
      step.indexOf('-X DELETE'),
    )
  })
})
