/**
 * `lib/motion.ts` calls itself "typed counterparts to the CSS `--motion-*` /
 * `--ease-*` tokens" and asks readers to keep the two in sync by hand. Nothing
 * enforced that, so this test does: it parses the real `index.css` token block
 * and checks every value against the TypeScript module.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DURATIONS_S, EASINGS } from '@/lib/motion'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

/** Read a `--name: value;` custom property out of the stylesheet. */
function cssVar(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`--${name} not found in index.css`)
  return match[1]!.trim()
}

function cssMs(name: string): number {
  const raw = cssVar(name)
  const match = raw.match(/^([\d.]+)ms$/)
  if (!match) throw new Error(`--${name} is "${raw}", expected a ms value`)
  return Number(match[1])
}

function cssBezier(name: string): number[] {
  const raw = cssVar(name)
  const match = raw.match(/^cubic-bezier\(([^)]+)\)$/)
  if (!match) throw new Error(`--${name} is "${raw}", expected a cubic-bezier`)
  return match[1]!.split(',').map((n) => Number(n.trim()))
}

describe('lib/motion — parity with the index.css token block', () => {
  it('exposes every duration in seconds, matching the CSS milliseconds', () => {
    expect(DURATIONS_S.instant).toBeCloseTo(cssMs('motion-instant') / 1000, 5)
    expect(DURATIONS_S.fast).toBeCloseTo(cssMs('motion-fast') / 1000, 5)
    expect(DURATIONS_S.base).toBeCloseTo(cssMs('motion-base') / 1000, 5)
    expect(DURATIONS_S.slow).toBeCloseTo(cssMs('motion-slow') / 1000, 5)
    expect(DURATIONS_S.glacial).toBeCloseTo(cssMs('motion-glacial') / 1000, 5)
  })

  it('exposes every cubic-bezier easing with the same control points', () => {
    expect(EASINGS.out).toEqual(cssBezier('ease-out') as typeof EASINGS.out)
    expect(EASINGS.inOut).toEqual(cssBezier('ease-in-out') as typeof EASINGS.inOut)
    expect(EASINGS.springSoft).toEqual(cssBezier('ease-spring-soft') as typeof EASINGS.springSoft)
    expect(EASINGS.springSnappy).toEqual(
      cssBezier('ease-spring-snappy') as typeof EASINGS.springSnappy,
    )
  })

  it('covers every --motion-* duration token defined in CSS', () => {
    const defined = [...css.matchAll(/--motion-([a-z]+):/g)].map((m) => m[1])
    expect(new Set(defined)).toEqual(new Set(Object.keys(DURATIONS_S)))
  })

  it('covers every --ease-* token defined in CSS', () => {
    const toCamel = (kebab: string) =>
      kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const defined = [...css.matchAll(/--ease-([a-z-]+):/g)].map((m) => toCamel(m[1]!))
    expect(new Set(defined)).toEqual(new Set(Object.keys(EASINGS)))
  })
})
