import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RESTYLE_SCRIPT, restyle } from '../lib/restyle'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** A page with the dashboard on it, styled or not, and a session store that may be unavailable. */
function page(opts: {
  styled: boolean
  dashboard?: boolean
  storage?: Map<string, string> | null
}) {
  const prepended: Array<{ text: string | null }> = []
  const reload = vi.fn()
  const storage = opts.storage === undefined ? new Map<string, string>() : opts.storage
  const win = {
    document: {
      querySelector: (sel: string) => (sel === '.cmd-root' && opts.dashboard !== false ? {} : null),
      createElement: () => {
        const el = { textContent: null as string | null, style: { cssText: '' }, setAttribute() {} }
        return el
      },
      body: {
        prepend: (el: { textContent: string | null }) => prepended.push({ text: el.textContent }),
      },
    },
    getComputedStyle: () => ({
      getPropertyValue: (name: string) =>
        opts.styled && name === '--cmd-surface' ? '#ffffff' : '',
    }),
    sessionStorage: {
      getItem: (k: string) => {
        if (storage === null) throw new Error('blocked')
        return storage.get(k) ?? null
      },
      setItem: (k: string, v: string) => {
        if (storage === null) throw new Error('blocked')
        storage.set(k, v)
      },
    },
    location: { reload },
  }
  return { win: win as unknown as Window, reload, prepended, storage }
}

describe('restyle, when the stylesheet did not apply', () => {
  it('does nothing on a styled page, or one without the dashboard', () => {
    for (const p of [page({ styled: true }), page({ styled: false, dashboard: false })]) {
      restyle(p.win)
      expect(p.reload).not.toHaveBeenCalled()
      expect(p.prepended).toEqual([])
    }
  })

  it('reloads once, then says so instead of reloading again within a minute', () => {
    const first = page({ styled: false })
    restyle(first.win)
    expect(first.reload).toHaveBeenCalledTimes(1)
    // The reload came back unstyled too: no loop.
    const again = page({ styled: false, storage: first.storage })
    restyle(again.win)
    expect(again.reload).not.toHaveBeenCalled()
    expect(again.prepended).toEqual([
      { text: "The page's styles did not load. Reload to try again." },
    ])
    // A minute later it may try again.
    vi.useFakeTimers({ now: Date.now() + 61_000 })
    try {
      const later = page({ styled: false, storage: again.storage })
      restyle(later.win)
      expect(later.reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so without reloading when session storage is unavailable', () => {
    const p = page({ styled: false, storage: null })
    restyle(p.win)
    expect(p.reload).not.toHaveBeenCalled()
    expect(p.prepended).toHaveLength(1)
  })

  it('runs as an inline script from its own source', () => {
    // The script parses and refers to nothing outside itself.
    const run = new Function('window', 'document', RESTYLE_SCRIPT)
    const p = page({ styled: false })
    const doc = { ...(p.win.document as object), readyState: 'complete' }
    run({ ...(p.win as object), document: doc }, doc)
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('is in the root layout, after the page', () => {
    const layout = read('app/layout.tsx')
    expect(layout).toMatch(/\{children\}[\s\S]*__html: RESTYLE_SCRIPT/)
  })
})

describe('the build output', () => {
  it('is cached for a year and never revalidated', () => {
    // public/_headers is copied into the Worker's assets; Workers otherwise serves them
    // "max-age=0, must-revalidate", a request through Access on every load.
    expect(read('public/_headers')).toMatch(
      /^\/_next\/static\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m,
    )
  })
})
