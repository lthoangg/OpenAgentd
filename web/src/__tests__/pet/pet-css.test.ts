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
