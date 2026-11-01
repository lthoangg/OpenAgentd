/**
 * Menu highlight (DESIGN.md → Floating Menus): the row under the pointer or
 * the keyboard fills with Bark. A keyed list (the command palette) lights only
 * the row it marks active, so a pointer parked over the list never lights a
 * second row while ↑/↓ move the highlight.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('menu highlight', () => {
  it('fills the marked row with the accent', () => {
    expect(css).toMatch(/\.oa-menu-item:is\(\[data-highlighted\][^{]*\{\s*background-color: var\(--color-accent\);/)
  })

  it('keeps pointer hover off keyed rows', () => {
    const hoverRules = css.match(/\.oa-menu-item[^{]*:hover[^{]*\{/g) ?? []
    expect(hoverRules.length).toBeGreaterThan(0)
    for (const rule of hoverRules) expect(rule).toContain('.oa-menu-item-keyed')
  })
})
