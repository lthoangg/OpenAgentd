/**
 * DESIGN.md: "Don't render UI text below 11px; the floor is enforced in CSS."
 * Responsive variants (``md:text-[10px]``) compile to their own selectors, so
 * every sub-11px class the source uses must have a floor rule in index.css.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const srcDir = fileURLToPath(new URL('../../', import.meta.url))
const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
const SUB_FLOOR_CLASS = /(?:[a-z0-9-]+:)?text-\[(?:8|9|10|10\.5)px\]/g

function usedSubFloorClasses(): string[] {
  const found = new Set<string>()
  for (const path of readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
    if (path.startsWith('__tests__') || !/\.tsx?$/.test(path)) continue
    for (const match of readFileSync(srcDir + path, 'utf8').matchAll(SUB_FLOOR_CLASS)) found.add(match[0])
  }
  return [...found].sort()
}

/** The declaration block of the rule that lists ``selector``. */
function ruleFor(selector: string): string | null {
  const at = css.indexOf(selector)
  if (at < 0) return null
  const open = css.indexOf('{', at)
  return open < 0 ? null : css.slice(open, css.indexOf('}', open))
}

describe('11px type floor', () => {
  it('covers every sub-11px text class used in the source, including md: variants', () => {
    const classes = usedSubFloorClasses()
    const missing = classes.filter((cls) => {
      const selector = `.${cls.replace(/[:[\].]/g, '\\$&')}`
      return !ruleFor(selector)?.includes('font-size: 11px')
    })
    expect(missing).toEqual([])
  })

  it('applies md: floors only from the md breakpoint', () => {
    const at = css.indexOf('.md\\:text-\\[10px\\]')
    expect(at).toBeGreaterThan(-1)
    expect(css.lastIndexOf('@media (width >= 48rem)', at)).toBeGreaterThan(css.lastIndexOf('}\n}', at))
  })
})
