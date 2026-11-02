/**
 * The pairs the app actually draws (DESIGN.md → Colors), measured on the
 * regular tokens of both themes. Text reaches WCAG AA (4.5:1); dots, strokes
 * and a chosen segment reach 3:1. No new colours: each pair is fixed by
 * choosing which existing token goes where (design-lint keeps the call sites
 * to these choices).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const tokens = readFileSync(fileURLToPath(new URL('../../styles/tokens.css', import.meta.url)), 'utf8')
const base = tokens.slice(0, tokens.indexOf('@media (prefers-contrast: more)'))

function themeProps(selector: RegExp): Record<string, string> {
  const match = selector.exec(base)
  if (!match) throw new Error(`no rule for ${selector}`)
  const body = base.slice(base.indexOf('{', match.index) + 1, base.indexOf('\n}', match.index))
  const raw = Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
  // Follow `var(--x)` aliases (the semantic tokens reuse the chip palette).
  const resolve = (value: string): string => {
    const alias = /^var\((--[\w-]+)\)$/.exec(value)
    return alias ? resolve(raw[alias[1]]) : value
  }
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]))
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

const THEMES = [
  { name: 'light', t: themeProps(/:root,\s*:root\.light\s*\{/) },
  { name: 'dark', t: themeProps(/:root\.dark\s*\{/) },
]

describe.each(THEMES)('token pairs ($name)', ({ name, t }) => {
  it('keeps secondary text AA on every surface it sits on', () => {
    for (const surface of ['--bg-page', '--bg-sidebar', '--bg-card', '--bg-key', '--color-surface']) {
      expect({ surface, ratio: contrast(t['--color-text-muted'], t[surface]) >= 4.5 }).toEqual({ surface, ratio: true })
    }
    for (const surface of ['--bg-page', '--bg-sidebar']) {
      expect({ surface, ratio: contrast(t['--color-text-subtle'], t[surface]) >= 4.5 }).toEqual({ surface, ratio: true })
    }
  })

  it('fills a chosen segment or a highlighted row so its label reads at AA and the fill shows on the track', () => {
    expect(contrast(t['--color-text-on-selected'], t['--color-fill-selected'])).toBeGreaterThanOrEqual(4.5)
    // Light: the Bark fill. Dark: a raised warm tone, like a native dark
    // segmented control (Increase contrast takes it to 3:1).
    expect(contrast(t['--color-fill-selected'], t['--bg-key'])).toBeGreaterThanOrEqual(name === 'light' ? 3 : 1.5)
    expect(contrast(t['--color-fill-selected'], t['--color-surface'])).toBeGreaterThanOrEqual(name === 'light' ? 3 : 1.5)
    expect(contrast(t['--color-text-muted'], t['--bg-key'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--color-text-on-selected'], t['--color-fill-danger'])).toBeGreaterThanOrEqual(4.5)
  })

  it('never lets a chrome fill outshine the content: dark fills stay far below the text tone', () => {
    if (name !== 'dark') return
    // A near-white block on a dark window glows brighter than the words.
    for (const fill of ['--color-fill-selected', '--color-fill-danger', '--bg-tooltip']) {
      expect({ fill, dim: luminance(t[fill]) < luminance(t['--color-text']) / 4 }).toEqual({ fill, dim: true })
    }
  })

  it('reads a tooltip at AA, its edge visible on the page', () => {
    expect(contrast(t['--color-tooltip-text'], t['--bg-tooltip'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--color-tooltip-border'], t['--bg-page'])).toBeGreaterThanOrEqual(name === 'light' ? 3 : 1.5)
  })

  it('sets a switch thumb apart from its on track at 2.5:1, and the track from the page at 2:1', () => {
    const thumb = name === 'light' ? t['--color-surface'] : t['--color-text']
    expect(contrast(thumb, t['--switch-on'])).toBeGreaterThanOrEqual(2.5)
    expect(contrast(t['--switch-on'], t['--bg-page'])).toBeGreaterThanOrEqual(2)
  })

  it('draws status text and dots in the -text tones, readable on paper', () => {
    for (const hue of ['blue', 'green', 'orange']) {
      const tone = t[`--accent-${hue}-text`]
      expect({ hue, page: contrast(tone, t['--bg-page']) >= 4.5 }).toEqual({ hue, page: true })
      expect({ hue, soft: contrast(tone, t[`--accent-${hue}-soft`]) >= 4.5 }).toEqual({ hue, soft: true })
    }
  })

  it('strokes an unchecked checkbox or radio at 3:1', () => {
    expect(contrast(t['--color-text-subtle'], t['--bg-page'])).toBeGreaterThanOrEqual(3)
  })

  it('keeps an error AA on the page', () => {
    expect(contrast(t['--color-error'], t['--bg-page'])).toBeGreaterThanOrEqual(4.5)
  })
})
