/**
 * The macOS app keeps the system's own scroll bars, which follow System
 * Settings → Appearance → "Show scroll bars" (DESIGN.md → Native first). Any
 * ``::-webkit-scrollbar`` style turns WebKit's native overlay bars into
 * custom ones, so the app's thin bars must not reach the macOS app.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const MAC_APP_EXCLUDED = ':where(html:not([data-platform="mac-overlay"]))'

/** Selectors of every rule that styles a visible scroll bar (not one that hides it). */
function scrollbarStylingSelectors(): string[] {
  const out: string[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = match
    const styles = /::-webkit-scrollbar/.test(selector) || /scrollbar-(?:width|color)\s*:/.test(body)
    const hides = /display:\s*none|scrollbar-width:\s*none/.test(body)
    if (styles && !hides) out.push(selector.trim())
  }
  return out
}

describe('scroll bars', () => {
  it('styles them outside the macOS app only', () => {
    const selectors = scrollbarStylingSelectors()
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      for (const part of selector.split(',')) expect([part.trim(), part.includes(MAC_APP_EXCLUDED)]).toEqual([part.trim(), true])
    }
  })
})
