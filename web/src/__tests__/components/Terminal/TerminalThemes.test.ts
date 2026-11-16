/**
 * Terminal colours are what programs print, so the palette cannot promise
 * contrast on its own: ANSI black is the dark background and white the light
 * one. xterm's minimumContrastRatio lifts any colour under it against the
 * cell it sits on (VS Code turns it on by default).
 */
import { describe, expect, it } from 'bun:test'

import { TERMINAL_MIN_CONTRAST_RATIO, TERMINAL_THEMES } from '@/components/Terminal/terminal-themes'

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

describe('terminal themes', () => {
  it('asks xterm to lift any printed colour to AA against its cell', () => {
    expect(TERMINAL_MIN_CONTRAST_RATIO).toBeGreaterThanOrEqual(4.5)
  })

  it('sets dim text (bright black: comments, hints, prompts) at AA on the dark background', () => {
    const dark = TERMINAL_THEMES.dark
    expect(contrast(dark.brightBlack!, dark.background!)).toBeGreaterThanOrEqual(4.5)
  })
})
