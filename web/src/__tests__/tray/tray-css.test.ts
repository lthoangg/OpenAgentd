/**
 * The tray popup used to carry its own copy of the palette and its own
 * timings, and drifted from the app (its red was not the app's red). It now
 * imports styles/tokens.css; this keeps it there. Only the marked tray-only
 * block (the glass surface, shadows, and the meter tick's halo) may hold
 * raw colours.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('../../tray/tray.css', import.meta.url)), 'utf8')

const START = '/* ── Tray-only values'
const END = '/* ── End tray-only values'

/** Lines that write a colour or motion value instead of using a token. */
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
      // A literal duration; 0.01ms is the reduced-motion snap, as in index.css.
      || /(?<![\w.-])(?!0\.01ms)\d*\.?\d+m?s\b/.test(line),
    )
    .map((line) => line.trim())
}

describe('tray.css', () => {
  it('takes its palette and motion from styles/tokens.css', () => {
    expect(CSS).toContain('@import "../styles/tokens.css";')
    expect(offTokenLines(CSS)).toEqual([])
  })

  it('catches a raw colour, duration or easing written outside the tray-only block', () => {
    const bad = `${CSS}\n.x { color: #a71c24; transition: opacity 0.12s ease; }\n.y { transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }`
    expect(offTokenLines(bad)).toEqual([
      '.x { color: #a71c24; transition: opacity 0.12s ease; }',
      '.y { transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }',
    ])
  })
})
