/**
 * Increased-contrast and Windows forced-colors support. happy-dom does not
 * evaluate these media queries, so this guards the rules and checks the
 * high-contrast tones against the page background.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const tokens = read('../../styles/tokens.css')
const indexCss = read('../../index.css')

const CONTRAST_QUERY = '@media (prefers-contrast: more) {'

/** The body of the first `{…}` block that starts at `start`, braces balanced. */
function blockAt(css: string, start: number): string {
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error('unbalanced block')
}

/** Custom properties of the rule whose selector list matches `selector`. */
function props(css: string, selector: RegExp): Record<string, string> {
  const match = selector.exec(css)
  if (!match) throw new Error(`no rule for ${selector}`)
  const body = blockAt(css, match.index)
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const contrastStart = tokens.indexOf(CONTRAST_QUERY)
const baseTokens = tokens.slice(0, contrastStart)
const contrastBlock = contrastStart >= 0 ? blockAt(tokens, contrastStart) : ''

describe('prefers-contrast: more', () => {
  for (const theme of [
    { name: 'light', base: /:root,\s*:root\.light\s*\{/, high: /:root,\s*:root\.light\s*\{/ },
    { name: 'dark', base: /:root\.dark\s*\{/, high: /:root\.dark\s*\{/ },
  ]) {
    it(`raises muted text and borders in the ${theme.name} theme`, () => {
      expect(contrastStart).toBeGreaterThan(0)
      const base = props(baseTokens, theme.base)
      const high = props(contrastBlock, theme.high)
      const page = base['--bg-page']
      for (const name of ['--color-text-muted', '--color-text-subtle']) {
        expect(contrast(high[name], page)).toBeGreaterThanOrEqual(7)
      }
      // WCAG 1.4.11: component boundaries at 3:1 against the page and sidebar.
      for (const name of ['--color-border', '--color-border-strong']) {
        expect(contrast(high[name], page)).toBeGreaterThanOrEqual(3)
        expect(contrast(high[name], base['--bg-sidebar'])).toBeGreaterThanOrEqual(3)
      }
      expect(contrast(high['--color-border-subtle'], page)).toBeGreaterThan(contrast(base['--color-border-subtle'], page))
    })
  }

  it('leaves the regular tokens as they were', () => {
    expect(props(baseTokens, /:root,\s*:root\.light\s*\{/)['--color-text-muted']).toBe('#6E604F')
    expect(props(baseTokens, /:root,\s*:root\.light\s*\{/)['--color-border']).toBe('#D9CFA9')
    expect(props(baseTokens, /:root\.dark\s*\{/)['--color-text-muted']).toBe('#9C8A72')
    expect(props(baseTokens, /:root\.dark\s*\{/)['--color-border']).toBe('#3A2F23')
  })
})

describe('forced-colors: active', () => {
  const start = indexCss.indexOf('@media (forced-colors: active) {')
  const forced = start >= 0 ? blockAt(indexCss, start) : ''

  it('draws keyboard focus as an outline, since forced colors drop ring shadows', () => {
    expect(forced).toMatch(/:focus-visible:not\(\[data-quiet-focus\]\)\s*\{[^}]*outline:\s*2px solid Highlight;/)
  })

  it('keeps the on state of a switch visible', () => {
    expect(forced).toMatch(/\[data-slot="switch"\]\[data-checked\]\s*\{[^}]*forced-color-adjust:\s*none;[^}]*background-color:\s*Highlight;/)
  })

  it('keeps the chosen segment visible', () => {
    expect(forced).toMatch(/\[data-slot="segmented-control"\] \[aria-checked="true"\]\s*\{[^}]*forced-color-adjust:\s*none;[^}]*background-color:\s*Highlight;/)
  })
})
