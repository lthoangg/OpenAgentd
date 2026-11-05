/**
 * Touch tablets in a browser now bind the app shell to the visual viewport
 * (`data-mobile-shell`, see use-mobile-viewport). Rules written for phones
 * must not leak into the tablet's card layouts, and a card must stay above
 * the soft keyboard.
 *
 * Settings and Usage are `AppOverlay` modals mounted at the app root
 * (`data-overlay-level="app"`): one frame with every other overlay, plus the
 * phone and keyboard rules a root-mounted overlay needs.
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

const APP_LEVEL = '.app-overlay-modal[data-overlay-level="app"]'

describe('app-level overlay card on a touch tablet', () => {
  it('keeps the phone-height rules to phone widths', () => {
    for (const selector of [`html[data-mobile-shell] ${APP_LEVEL}`, `html[data-mobile-shell][data-keyboard-open] ${APP_LEVEL}`]) {
      const rules = rulesFor(selector)
      expect(rules.length).toBeGreaterThan(0)
      for (const rule of rules) {
        if (!/(?<![-\w])height\s*:/.test(rule.body)) continue
        expect({ selector, within: rule.within }).toEqual({ selector, within: ['@media (max-width: 767px)'] })
      }
    }
  })

  it('bounds the card by the visible height while the keyboard is up', () => {
    const rules = rulesFor(`html[data-mobile-shell][data-keyboard-open] ${APP_LEVEL}`)
    const wide = rules.find((r) => r.within.includes('@media (min-width: 768px)'))
    expect(wide?.body).toContain('max-height: calc(var(--app-vh, 100svh)')
  })
})

describe('overlay card on a desktop window', () => {
  const wide = () => rulesFor('.app-overlay-modal').find((r) => r.within.includes('@media (min-width: 768px)'))

  it('keeps the same gap above the status bar as below the header', () => {
    // At 4vh from the bottom it sat flush on the 28px status bar. One edge for
    // every modal: Settings and Usage no longer have a frame of their own.
    expect(wide()?.body).toContain('top: calc(var(--spacing-app-header) + 4vh)')
    expect(wide()?.body).toContain('bottom: calc(var(--spacing-status-bar) + 4vh)')
    expect(wide()?.body).toContain('max-height: calc(100svh - var(--spacing-app-header) - var(--spacing-status-bar) - 8vh)')
  })

  it('takes its width from the overlay, up to 95% of the window', () => {
    expect(wide()?.body).toContain('width: min(95vw, var(--overlay-max-width, 860px))')
  })

  it('has no frame of its own for Settings any more', () => {
    expect(css).not.toContain('settings-modal-shell')
  })
})

describe('app header on a touch tablet', () => {
  it('is taller than its 36px touch buttons, so they do not fill it edge to edge', () => {
    // At the desktop 36px the command palette and the toggles touched both
    // the window top and the header's bottom rule.
    const rem = (body: string) => Number(/--spacing-app-header:\s*([\d.]+)rem/.exec(body)?.[1])
    const tablet = rulesFor(':root').find((r) => r.within.includes('@media (pointer: coarse) and (min-width: 768px)'))
    expect(rem(tablet?.body ?? '') * 16).toBeGreaterThanOrEqual(36 + 8)
  })
})
