/**
 * Touch floors (plan principle 1): 36px for every button on a touch screen,
 * 44px for a primary button on a phone.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function block(media: string): string {
  const at = css.indexOf(`@media ${media} {`)
  if (at < 0) return ''
  let depth = 0
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1)
  }
  return ''
}

describe('touch floors', () => {
  it('gives every button 36px on a touch screen', () => {
    expect(block('(pointer: coarse)')).toMatch(/\[data-slot="button"\]\s*\{\s*min-height: 36px;/)
  })

  it('gives a primary button 44px on a phone', () => {
    expect(block('(pointer: coarse) and (max-width: 767px)')).toMatch(/\[data-slot="button"\]\[data-variant="primary"\]\s*\{\s*min-height: 44px;/)
  })
})
