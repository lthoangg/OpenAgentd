/**
 * The popup's buttons were 22–24px, with a 11px underlined "Retry". Every
 * control is at least 28px high now, and the text is 12px.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('../../tray/tray.css', import.meta.url)), 'utf8')

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...CSS.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join('\n')
}

function px(selector: string, property: string): number | null {
  const match = new RegExp(`(?:^|[\\s;])${property}:\\s*([\\d.]+)px`).exec(block(selector))
  return match ? Number(match[1]) : null
}

describe('tray.css targets and text', () => {
  it('makes every button at least 28px', () => {
    expect(px('.icon-btn', 'width')).toBeGreaterThanOrEqual(28)
    expect(px('.icon-btn', 'height')).toBeGreaterThanOrEqual(28)
    expect(px('.small-btn', 'height')).toBeGreaterThanOrEqual(28)
    expect(px('.picker-trigger', 'height')).toBeGreaterThanOrEqual(28)
    expect(px('.action', 'height')).toBeGreaterThanOrEqual(28)
  })

  it('has no text-only underlined link for Retry', () => {
    expect(CSS).not.toContain('.link-btn')
    expect(CSS).not.toContain('text-decoration: underline')
  })

  it('keeps its text at 12px or the small caps group heading at 11px, never below', () => {
    const sizes = [...CSS.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]))
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11)
    expect(px('.status', 'font-size')).toBe(12)
  })
})
