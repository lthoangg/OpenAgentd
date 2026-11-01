/**
 * Touch tablets in a browser now bind the app shell to the visual viewport
 * (`data-mobile-shell`, see use-mobile-viewport). Rules written for phones
 * must not leak into the tablet's card layouts, and a card must stay above
 * the soft keyboard.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Each rule whose selector is exactly `selector`: its enclosing at-rules and its body. */
function rulesFor(selector: string): Array<{ within: string[]; body: string }> {
  const found: Array<{ within: string[]; body: string }> = []
  const stack: string[] = []
  let start = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') {
      const prelude = css.slice(start, i).trim()
      if (prelude === selector) {
        const end = css.indexOf('}', i)
        found.push({ within: [...stack], body: css.slice(i + 1, end) })
      }
      stack.push(prelude)
      start = i + 1
    } else if (ch === '}') {
      stack.pop()
      start = i + 1
    } else if (ch === ';') {
      start = i + 1
    }
  }
  return found
}

describe('settings card on a touch tablet', () => {
  it('keeps the phone-height rules to phone widths', () => {
    for (const selector of ['html[data-mobile-shell] .settings-modal-shell', 'html[data-mobile-shell][data-keyboard-open] .settings-modal-shell']) {
      const rules = rulesFor(selector)
      expect(rules.length).toBeGreaterThan(0)
      for (const rule of rules) {
        if (!/(?<![-\w])height\s*:/.test(rule.body)) continue
        expect({ selector, within: rule.within }).toEqual({ selector, within: ['@media (max-width: 767px)'] })
      }
    }
  })

  it('bounds the card by the visible height while the keyboard is up', () => {
    const rules = rulesFor('html[data-mobile-shell][data-keyboard-open] .settings-modal-shell')
    const wide = rules.find((r) => r.within.includes('@media (min-width: 768px)'))
    expect(wide?.body).toContain('max-height: calc(var(--app-vh, 100svh)')
  })
})
