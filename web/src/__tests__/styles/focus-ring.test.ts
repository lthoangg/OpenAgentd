/**
 * Keyboard focus (DESIGN.md → Focus): a solid 2px outline, 2px out. The
 * outline rule is unlayered so a component's `focus-visible:outline-none`
 * cannot drop it, which also overrides any offset a component sets. Controls
 * drawn with an inset ring (a segment in its track, a tab in its strip, a row
 * flush in a scroller, a confirm's footer button) inset the outline with
 * them; outset, the track or the scroller clips it to a stray bar on one side.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const css = read('index.css').replace(/\/\*[\s\S]*?\*\//g, '')

/** The unlayered rule that insets the outline: its selector and its body. */
function insetRule(): { selector: string; body: string } | null {
  const match = css.match(/(:where\(button, select, a\[href\], \[tabindex\]\):focus-visible:is\([^{]*\))\s*\{([^}]*)\}/)
  return match ? { selector: match[1]!, body: match[2]! } : null
}

describe('keyboard focus ring', () => {
  it('insets the solid outline for controls drawn with an inset ring', () => {
    const rule = insetRule()
    expect(rule).not.toBeNull()
    expect(rule!.body.trim()).toBe('outline-offset: -2px;')
    for (const marker of [
      '[data-focus-ring="inset"]',
      '.oa-menu-item',
      '[class~="focus-visible:ring-inset"]',
      '[class~="focus-visible:-outline-offset-2"]',
      '[class~="[&>[data-slot=button]]:focus-visible:ring-inset"] > *',
    ]) expect(rule!.selector).toContain(marker)
  })

  it('keeps the inset rule out of every @layer, so it beats the outline it adjusts', () => {
    const layered = css.match(/@layer[^{]*\{[\s\S]*?\n\}/g) ?? []
    for (const block of layered) expect(block).not.toContain('focus-visible:is(')
  })

  // Tab scrolls a control in a scroller only to the nearest edge; without a
  // margin its ring (2px out, 2px wide) lands under the clip.
  it('keeps a control Tab scrolls into view clear of its scroller edge', () => {
    const base = css.match(/@layer base\s*\{[\s\S]*?\n\}/g)?.join('\n') ?? ''
    expect(base).toMatch(/:where\(button, select, a\[href\], \[tabindex\]\)\s*\{\s*scroll-margin-block: 6px;\s*\}/)
  })

  it('insets the status bar items, which sit on the window edge in a clipping row', () => {
    const footer = read('components/AppFooter.tsx')
    for (const name of ['ITEM', 'ICON_ITEM']) {
      expect(footer).toMatch(new RegExp(`const ${name} =\\s*'[^']*focus-visible:ring-inset`))
    }
    expect(read('components/HealthDot.tsx')).toMatch(/'flex h-5 items-center[^']*focus-visible:ring-inset/)
  })

  it('brings the skip link in from the window corner so its whole ring shows', () => {
    expect(css).toMatch(/\.skip-link:focus-visible\s*\{\s*translate: 8px 48px;\s*\}/)
  })

  it('rings the transcript inside its column when F6 lands on it', () => {
    expect(read('components/AgentView.tsx')).toMatch(/data-focus-region="transcript"\s+data-region-self=""\s+data-focus-ring="inset"/)
  })

  it('insets the 32px buttons that lead the 36px header, which clips overflow', () => {
    const header = read('components/AgentChatView/AgentChatHeader.tsx')
    expect(header).toMatch(/const HEADER_LEAD_FOCUS = 'focus-visible:ring-inset'/)
    for (const label of ['Application menu', 'Open the main agent', 'Toggle sidebar']) {
      const at = header.indexOf(`aria-label="${label}"`)
      expect(at).toBeGreaterThan(0)
      const props = header.slice(header.lastIndexOf('<Button', at), header.indexOf('</Button>', at))
      expect(props).toContain('HEADER_LEAD_FOCUS')
    }
  })
})
