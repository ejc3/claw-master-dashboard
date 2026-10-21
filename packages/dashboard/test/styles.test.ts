import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPARKLE_MS } from '../src/react/Pool'

// Contracts of the stylesheet that no runtime test reaches, checked on its source.
const css = readFileSync(new URL('../src/react/dashboard.css', import.meta.url), 'utf8')

/** Every rule as [selector, body], with comments removed; nested blocks are flattened. */
function rules(source: string): Array<[string, string]> {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Array<[string, string]> = []
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push([(m[1] ?? '').trim(), m[2] ?? ''])
  }
  return out
}

function block(start: string): string {
  const at = css.indexOf(start)
  expect(at).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1)
  }
  throw new Error(`unclosed block: ${start}`)
}

const tokens = (text: string) =>
  new Set([...text.matchAll(/(--cmd-[a-z0-9-]+):/g)].map((m) => m[1] as string))

describe('dashboard.css', () => {
  it('defines every light color token in both dark scopes', () => {
    const light = tokens(block('  .cmd-root {'))
    const media = tokens(block('  @media (prefers-color-scheme: dark)'))
    const toggle = tokens(block('  :root[data-theme="dark"] .cmd-root'))
    for (const t of ['--cmd-font', '--cmd-font-sans', '--cmd-radius']) light.delete(t)
    expect([...light].filter((t) => !media.has(t))).toEqual([])
    expect([...light].filter((t) => !toggle.has(t))).toEqual([])
  })

  it('colors state marks through custom properties, so forced colors can override them', () => {
    // A state selector that sets `background` on a mark outranks the forced-colors rule for it,
    // and the mark is then painted Canvas: a full bar looks empty.
    // Anywhere in the file outside the forced-colors block, in any form of the property.
    // The marks are whatever the forced-colors block paints CanvasText, so a mark added there
    // is guarded here too.
    const forced = block('  @media (forced-colors: active)')
    const canvasText = rules(forced)
      .filter(([, body]) => /background:\s*CanvasText/.test(body))
      .flatMap(([selector]) => selector.split(',').map((x) => x.trim()))
    for (const mark of [
      '.cmd-runway-used',
      '.cmd-row::before',
      '.cmd-pulse',
      '.cmd-account-bar > span',
    ]) {
      expect(canvasText).toContain(mark)
    }
    // The class (or pseudo-element) each mark selector ends in.
    const tails = canvasText.map((selector) => selector.split(/\s+/).at(-1) ?? selector)
    const targets = (selector: string) =>
      selector
        .split(',')
        .map((x) => x.trim().split(/\s+/).at(-1) ?? '')
        .some((tail) => tails.some((t) => tail.endsWith(t.replace(/^\.cmd-row/, ''))))
    const offenders = rules(css.replace(forced, ''))
      .filter(
        ([selector]) => /\[data-/.test(selector) && (targets(selector) || selector.includes('&')),
      )
      .filter(([, body]) => /(^|;|\s)background(-color)?\s*:/.test(body))
      .map(([selector]) => selector)
    expect(offenders).toEqual([])
  })

  it('keeps pressed controls readable in forced colors', () => {
    const forced = block('  @media (forced-colors: active)')
    const pressed = rules(forced).find(([selector]) =>
      selector.includes('.cmd-tabs button[aria-pressed="true"]'),
    )
    expect(pressed?.[1]).toMatch(/forced-color-adjust:\s*none/)
    expect(pressed?.[0]).toContain('.cmd-segmented button[aria-pressed="true"]')
  })

  it('leaves the side padding of empty and error lines to their container', () => {
    const rule = rules(css).find(([selector]) => /^\.cmd-empty,\s*\.cmd-error$/.test(selector))
    expect(rule?.[1]).toBeDefined()
    expect(rule?.[1]).not.toMatch(/(^|\s)padding\s*:/)
  })

  it('draws the banner link in the stronger accent (4.5:1 on the tinted banner)', () => {
    const rule = rules(css).find(([selector]) => selector === '.cmd-banner a')
    expect(rule?.[1]).toMatch(/color:\s*var\(--cmd-accent-strong\)/)
  })

  it('draws a bar with no reading dashed in forced colors, unlike a 0% one', () => {
    const forced = block('  @media (forced-colors: active)')
    expect(forced).toMatch(
      /\.cmd-account-bar\[data-level="unknown"\]\s*\{[^}]*border-style:\s*dashed/,
    )
  })
})

describe('the subscription detail', () => {
  it('floats over the charts on a wide screen, so hovering a subscription moves nothing', () => {
    // In the flow it grew the vertically centered block: the row moved 14px under the pointer and the
    // charts below moved down on every hover.
    const wide = rules(block('  @media (min-width: 720px) {\n    .cmd-pool-head'))
    const body = (selector: string) => wide.find(([s]) => s === selector)?.[1] ?? ''
    expect(body('.cmd-accounts')).toMatch(/position:\s*relative/)
    expect(body('.cmd-account-detail')).toMatch(/position:\s*absolute/)
    expect(body('.cmd-account-detail')).toMatch(/top:\s*100%/)
    // No gap below the block for a mouse to cross on its way to a calendar link (a gap closed it).
    expect(body('.cmd-account-detail')).toMatch(/margin-top:\s*0/)
  })

  it('is not cut off by the pool panel when the header is all there is', () => {
    // With every login expired there are no charts; overflow: hidden on the panel cut the detail off.
    const all = rules(css)
    const pool = all.find(([s]) => s === '.cmd-pool')?.[1] ?? ''
    expect(pool).not.toMatch(/overflow:\s*(hidden|clip)/)
    // The header rounds its own tinted corners: the top two, or all four when nothing follows it.
    expect(all.find(([s]) => s === '.cmd-pool-head')?.[1]).toMatch(/border-radius:/)
    expect(all.find(([s]) => s === '.cmd-pool-head:last-child')?.[1]).toMatch(/border-radius:/)
    // Nor does the charts' square bottom line run past the panel's rounded corners.
    expect(all.find(([s]) => s === '.cmd-capacity:last-child')?.[1]).toMatch(/border-bottom:\s*0/)
  })
})

describe('the sparkle', () => {
  it('is kept until its last star has faded', () => {
    const rules = css.slice(css.indexOf('.cmd-sparkle svg {'))
    const duration = Number(/animation: cmd-sparkle ([\d.]+)s/.exec(rules)?.[1]) * 1000
    const delays = [...rules.matchAll(/animation-delay: (\d+)ms/g)].map((m) => Number(m[1]))
    expect(duration).toBeGreaterThan(0)
    expect(delays.length).toBeGreaterThan(0)
    expect(SPARKLE_MS).toBeGreaterThanOrEqual(duration + Math.max(...delays))
  })
})
