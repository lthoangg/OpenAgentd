/**
 * The pet takes its palette and motion from styles/tokens.css, like the
 * island and the tray popup. Only the marked pet-only block may hold raw
 * colours and timings.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('../../pet/pet.css', import.meta.url)), 'utf8')

const START = '/* ── Pet-only values'
const END = '/* ── End pet-only values'

function offTokenLines(css: string): string[] {
  const start = css.indexOf(START)
  const end = css.indexOf(END)
  const outside = start >= 0 && end > start ? css.slice(0, start) + css.slice(end) : css
  return outside
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) =>
      /#[0-9a-f]{3,8}\b/i.test(line)
      || /\b(?:rgba?|hsla?)\(/i.test(line)
      || /cubic-bezier\(/i.test(line)
      || /transition:\s*all\b/i.test(line)
      || /(?<![\w.-])\d*\.?\d+m?s\b/.test(line),
    )
    .map((line) => line.trim())
}

describe('pet.css', () => {
  it('takes its palette and motion from styles/tokens.css', () => {
    expect(CSS).toContain('@import "../styles/tokens.css";')
    expect(offTokenLines(CSS)).toEqual([])
  })

  it('has a reduced-motion fallback', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

/** The declarations of every rule written for exactly `selector`. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...CSS.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join('\n')
}

function px(selector: string, property: string): number | null {
  const match = new RegExp(`(?:^|[\\s;])${property}:\\s*([\\d.]+)px`).exec(block(selector))
  return match ? Number(match[1]) : null
}

describe('pet.css sizes', () => {
  // Controls were 18–20px; the primary ones were as small as their text.
  it('gives every button at least 24px, and the main ones 28px', () => {
    expect(px('.pet-bubble-close', 'width')).toBeGreaterThanOrEqual(28)
    expect(px('.pet-bubble-close', 'height')).toBeGreaterThanOrEqual(28)
    expect(px('.pet-button', 'height')).toBeGreaterThanOrEqual(28)
    expect(px('.pet-badge', 'min-width')).toBeGreaterThanOrEqual(24)
    expect(px('.pet-badge', 'height')).toBeGreaterThanOrEqual(24)
    expect(px('.pet-list-dismiss', 'width')).toBeGreaterThanOrEqual(24)
    expect(px('.pet-list-dismiss', 'height')).toBeGreaterThanOrEqual(24)
    expect(px('.pet-list-open', 'min-height')).toBeGreaterThanOrEqual(28)
  })

  it('sets its text at 12px, with nothing smaller than 11px', () => {
    expect(px('body', 'font-size')).toBe(12)
    expect(px('.pet-say', 'font-size')).toBe(12)
    const sizes = [...CSS.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]))
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11)
    expect(CSS).not.toContain('11.5px')
  })

  it('backs the white "z z" with a chip so it reads on a light wallpaper', () => {
    expect(block('.pet-zzz')).toContain('background: var(--pet-snooze-chip)')
  })
})
