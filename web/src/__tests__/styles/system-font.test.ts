/**
 * Native type (DESIGN.md → Typography): interface text uses the host OS's
 * own UI font (SF Pro, Segoe UI Variable, Roboto, the Linux desktop font),
 * from one stack in tokens.css shared by the app, tray, island and pet.
 * JetBrains Mono stays for code. Inter is no longer bundled.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('system UI font', () => {
  const tokens = read('../../styles/tokens.css')

  // system-ui comes before Roboto: on Linux it is the desktop's own face,
  // which an installed Roboto would otherwise replace; on Android it is
  // Roboto or the maker's font. Roboto stays for browsers without system-ui.
  it('defines one native stack: Apple, Windows, the system face, then Roboto', () => {
    const stack = /--font-ui:\s*([^;]+);/.exec(tokens)?.[1] ?? ''
    const order = ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', 'Roboto']
    const at = order.map((name) => stack.indexOf(name))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(stack).not.toContain('Inter')
  })

  // The Linux app's desktop font (public/theme-init.js) goes first; without
  // it the stack starts with -apple-system as before.
  it("starts with the Linux desktop's font when the app hands one over", () => {
    const stack = /--font-ui:\s*([^;]+);/.exec(tokens)?.[1] ?? ''
    expect(stack.startsWith('var(--font-desktop, -apple-system),')).toBe(true)
  })

  it('uses that stack for the app and every desktop companion', () => {
    expect(read('../../index.css')).toMatch(/--font-sans:\s*var\(--font-ui\);/)
    for (const file of ['../../island/island.css', '../../pet/pet.css', '../../tray/tray.css']) {
      const css = read(file)
      expect({ file, inter: css.includes('Inter') }).toEqual({ file, inter: false })
      expect({ file, stack: css.includes('var(--font-ui)') }).toEqual({ file, stack: true })
    }
  })

  it('no longer bundles Inter', () => {
    for (const file of ['../../index.css', '../../tray/main.tsx', '../../pet/main.tsx', '../../island/main.tsx']) {
      expect({ file, inter: read(file).includes('@fontsource-variable/inter') }).toEqual({ file, inter: false })
    }
  })
})
