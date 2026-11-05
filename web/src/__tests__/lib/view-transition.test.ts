/**
 * Light ↔ dark (and the text size) crossfade the window through the View
 * Transitions API where there is one; without it, under reduced motion, or
 * when nothing changes, the change applies at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { withViewTransition } from '@/lib/view-transition'
import { setThemePreference } from '@/lib/theme'

// A loose handle: the DOM lib's own typing is stricter than the stub needs.
type Doc = { startViewTransition?: (update: () => void) => { finished: Promise<void> } }
const doc = document as unknown as Doc
const originalMatchMedia = window.matchMedia
let started = 0

function stubReduced(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'), media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(() => {
  started = 0
  stubReduced(false)
  doc.startViewTransition = (update) => { started++; update(); return { finished: Promise.resolve() } }
})
afterEach(() => {
  delete doc.startViewTransition
  window.matchMedia = originalMatchMedia
  document.documentElement.classList.remove('dark', 'light')
})

describe('withViewTransition', () => {
  it('runs the change inside a view transition', () => {
    let applied = false
    withViewTransition(() => { applied = true })
    expect(started).toBe(1)
    expect(applied).toBe(true)
  })

  it('applies at once under reduced motion', () => {
    stubReduced(true)
    let applied = false
    withViewTransition(() => { applied = true })
    expect(started).toBe(0)
    expect(applied).toBe(true)
  })

  it('applies at once where the API is missing', () => {
    delete doc.startViewTransition
    let applied = false
    withViewTransition(() => { applied = true })
    expect(applied).toBe(true)
  })
})

describe('theme changes', () => {
  it('crossfades a new theme and not a repeat of the same one', () => {
    document.documentElement.classList.add('light')
    setThemePreference('dark')
    expect(started).toBe(1)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    setThemePreference('dark')
    expect(started).toBe(1)
  })
})
