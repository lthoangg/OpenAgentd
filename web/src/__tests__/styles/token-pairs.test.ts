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

/**
 * APCA lightness contrast (|Lc|, 0.0.98G constants). WCAG 2 overstates
 * contrast near black, so dark secondary text that reads 5.6:1 can still look
 * dim; APCA rates it the way the eye does (DESIGN.md → Colors).
 */
function apca(text: string, bg: string): number {
  const y = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.4)
    const raw = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    return raw < 0.022 ? raw + (0.022 - raw) ** 1.414 : raw
  }
  const [yt, yb] = [y(text), y(bg)]
  const s = yb > yt ? (yb ** 0.56 - yt ** 0.57) * 1.14 : (yb ** 0.65 - yt ** 0.62) * 1.14
  if (Math.abs(s) < 0.1) return 0
  return Math.abs(s > 0 ? s - 0.027 : s + 0.027) * 100
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

  it('fills a chosen segment clearly, never a dark block: its label reads at AA', () => {
    expect(contrast(t['--color-text-on-selected'], t['--color-fill-selected'])).toBeGreaterThanOrEqual(4.5)
    // A tone that reads as picked at a glance on the track and the card (a
    // 1.2:1 step left Light / Dark / System looking unchosen), yet never a
    // dark block on paper or a glowing one on dark (Increase contrast takes
    // it to 3:1).
    for (const surface of ['--bg-key', '--bg-card', '--color-surface']) {
      const ratio = contrast(t['--color-fill-selected'], t[surface])
      expect({ surface, shows: ratio >= 1.4, quiet: ratio <= 1.8 }).toEqual({ surface, shows: true, quiet: true })
    }
    expect(contrast(t['--color-text-muted'], t['--bg-key'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--color-text-on-danger'], t['--color-fill-danger'])).toBeGreaterThanOrEqual(4.5)
  })

  it('marks a chosen segment on the keycap track (Code / Plan) as clearly on dark as on paper', () => {
    const ratio = contrast(t['--color-fill-selected'], t['--bg-key'])
    expect({ shows: ratio >= 1.4, soft: ratio <= 1.6 }).toEqual({ shows: true, soft: true })
  })

  it('lights the menu row under the pointer or keyboard with a wash, quieter than a chosen segment', () => {
    const fill = t['--color-fill-highlight']
    expect(contrast(t['--color-text-on-highlight'], fill)).toBeGreaterThanOrEqual(4.5)
    // A row that only follows the pointer is a wash, as a native list's
    // hover: never a block that darkens the row on paper.
    for (const surface of ['--bg-card', '--color-surface']) {
      const ratio = contrast(fill, t[surface])
      const chosen = contrast(t['--color-fill-selected'], t[surface])
      expect({ surface, shows: ratio >= 1.12, wash: ratio <= 1.35, quieter: ratio < chosen })
        .toEqual({ surface, shows: true, wash: true, quieter: true })
    }
  })

  it('keeps light fills light: the label is dark on them, as on paper', () => {
    if (name !== 'light') return
    for (const fill of ['--color-fill-selected', '--color-fill-highlight', '--color-fill-key-hover', '--color-fill-danger', '--bg-tooltip']) {
      expect({ fill, light: luminance(t[fill]) > 0.5 }).toEqual({ fill, light: true })
    }
  })

  it('hovers a control on the keycap wash half way to a chosen one, never as dark as it', () => {
    const hover = t['--color-fill-key-hover']
    const rest = t['--bg-key']
    const chosen = t['--color-fill-selected']
    // The step shows, the hovered control is still told apart from the chosen
    // one, and its labels stay AA (a hovered muted label takes --color-text-2).
    expect(contrast(hover, rest)).toBeGreaterThanOrEqual(1.05)
    expect(contrast(hover, rest)).toBeLessThan(contrast(chosen, rest))
    expect(contrast(chosen, hover)).toBeGreaterThanOrEqual(1.05)
    expect(contrast(t['--color-text'], hover)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--color-text-2'], hover)).toBeGreaterThanOrEqual(4.5)
  })

  it('never lets a chrome fill outshine the content: dark fills stay far below the text tone', () => {
    if (name !== 'dark') return
    // A near-white block on a dark window glows brighter than the words.
    for (const fill of ['--color-fill-selected', '--color-fill-highlight', '--color-fill-key-hover', '--color-fill-danger', '--bg-tooltip']) {
      expect({ fill, dim: luminance(t[fill]) < luminance(t['--color-text']) / 4 }).toEqual({ fill, dim: true })
    }
  })

  it('reads a tooltip at AA, its edge visible on the page', () => {
    expect(contrast(t['--color-tooltip-text'], t['--bg-tooltip'])).toBeGreaterThanOrEqual(4.5)
    // A light card on paper (light), a raised tone on dark: the edge and the
    // shadow set it off, as a native tooltip.
    expect(contrast(t['--color-tooltip-border'], t['--bg-page'])).toBeGreaterThanOrEqual(1.4)
  })

  it('sets a switch thumb apart from its on track at 2.5:1, and the track from the page at 2:1', () => {
    // On, the thumb takes the ink that sits on the accent.
    const thumb = t['--color-text-on-accent']
    expect(contrast(thumb, t['--switch-on'])).toBeGreaterThanOrEqual(2.5)
    expect(contrast(t['--switch-on'], t['--bg-page'])).toBeGreaterThanOrEqual(2)
  })

  it('sets a switch that is off apart from the card it sits on, and its thumb from the track', () => {
    // Off, the track is a solid border-strong (components/ui/switch.tsx); the
    // thumb is the surface on paper and the ink on dark.
    const track = t['--color-border-strong']
    const thumb = name === 'light' ? t['--color-surface'] : t['--color-text']
    for (const surface of ['--bg-page', '--bg-card']) {
      expect({ surface, ratio: contrast(track, t[surface]) >= 2.2 }).toEqual({ surface, ratio: true })
    }
    expect(contrast(thumb, track)).toBeGreaterThanOrEqual(2.2)
  })

  it('draws keyboard focus at 3:1 on every surface a focused control sits on, chosen fills included', () => {
    for (const surface of ['--bg-page', '--bg-sidebar', '--bg-card', '--bg-key', '--color-surface', '--color-fill-selected']) {
      expect({ surface, ratio: contrast(t['--focus-ring'], t[surface]) >= 3 }).toEqual({ surface, ratio: true })
    }
  })

  it('keeps secondary text readable by eye, not just by the WCAG 2 ratio (APCA)', () => {
    // Comparable dark themes set secondary text at Lc 45–50 (GitHub, Material,
    // macOS); at Lc 34–40 timestamps and hints looked dim beside the ink.
    for (const surface of ['--bg-page', '--bg-sidebar', '--bg-card']) {
      expect({ surface, text2: apca(t['--color-text-2'], t[surface]) >= 68 }).toEqual({ surface, text2: true })
      expect({ surface, muted: apca(t['--color-text-muted'], t[surface]) >= 48 }).toEqual({ surface, muted: true })
    }
    for (const surface of ['--bg-page', '--bg-sidebar']) {
      expect({ surface, subtle: apca(t['--color-text-subtle'], t[surface]) >= 42 }).toEqual({ surface, subtle: true })
    }
  })

  it('keeps the text ramp in order: each step reads below the one above it', () => {
    const page = t['--bg-page']
    const steps = ['--color-text', '--color-text-2', '--color-text-muted', '--color-text-subtle'].map((k) => apca(t[k], page))
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1])
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

  it('reads every syntax colour at AA on code blocks and the keycap strips around them', () => {
    const syntax = Object.keys(t).filter((k) => k.startsWith('--color-syn-'))
    expect(syntax.length).toBeGreaterThan(5)
    for (const token of syntax) {
      for (const surface of ['--bg-input', '--bg-card', '--bg-key', '--color-surface']) {
        expect({ token, surface, aa: contrast(t[token], t[surface]) >= 4.5 }).toEqual({ token, surface, aa: true })
      }
    }
  })

  it('draws chart markers at 3:1 on the card, as data graphics', () => {
    for (const marker of ['--color-marker-blue', '--color-marker-mint', '--color-marker-orange', '--color-marker-pink', '--color-marker-yellow', '--color-violet']) {
      expect({ marker, ratio: contrast(t[marker], t['--bg-card']) >= 3 }).toEqual({ marker, ratio: true })
    }
  })
})
