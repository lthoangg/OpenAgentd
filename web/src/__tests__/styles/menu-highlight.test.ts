/**
 * Menu highlight (DESIGN.md → Floating Menus): the row under the pointer or
 * the keyboard takes the highlight wash, softer than the fill of a chosen
 * segment. A keyed list (the command palette) lights only the row it marks
 * active, so a pointer parked over the list never lights a second row while
 * ↑/↓ move the highlight.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('menu highlight', () => {
  it('washes the marked row with the highlight fill, not the stronger selection fill', () => {
    expect(css).toMatch(/\.oa-menu-item:is\(\[data-highlighted\][^{]*\{\s*background-color: var\(--color-fill-highlight\);\s*color: var\(--color-text-on-highlight\);/)
    expect(css).toMatch(/\.oa-menu-item:hover:not\([^{]*\.oa-menu-item-keyed\)\s*\{\s*background-color: var\(--color-fill-highlight\);\s*color: var\(--color-text-on-highlight\);/)
    expect(css).not.toMatch(/\.oa-menu-item[^{]*\{\s*background-color: var\(--color-fill-selected\)/)
    expect(css).not.toMatch(/\.oa-menu-item[^{]*\{\s*background-color: var\(--color-accent\)/)
  })

  it('gives a destructive row its own label tone on the danger fill', () => {
    expect(css).toMatch(/\.oa-menu-item\.oa-menu-item-danger:is\(\[data-highlighted\][^{]*\{\s*background-color: var\(--color-fill-danger\);\s*color: var\(--color-text-on-danger\);/)
    expect(css).toMatch(/\.oa-menu-item\.oa-menu-item-danger:hover[^{]*\{\s*background-color: var\(--color-fill-danger\);\s*color: var\(--color-text-on-danger\);/)
  })

  it('keeps pointer hover off keyed rows', () => {
    const hoverRules = css.match(/\.oa-menu-item[^{]*:hover[^{]*\{/g) ?? []
    expect(hoverRules.length).toBeGreaterThan(0)
    for (const rule of hoverRules) expect(rule).toContain('.oa-menu-item-keyed')
  })
})
