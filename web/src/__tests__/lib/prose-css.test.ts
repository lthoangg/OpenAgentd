/**
 * Markdown in answers (`.oa-prose`, index.css). Tailwind's preflight strips
 * every heading to body text, so each level needs a rule of its own; happy-dom
 * does not apply the stylesheet, so this guards the rules themselves.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Every declaration block whose selector list has `selector` as one item
 *  (so `.tool-desc .oa-prose h3`, a different surface, does not count). */
function rulesFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = css.match(new RegExp(`(^|[{}])\\s*(?:[^{},]*,\\s*)*${escaped}\\s*(,[^{}]*)?\\{[^}]*\\}`, 'g')) ?? []
  return found.join('\n')
}

describe('answer headings', () => {
  it('sets h4 to h6 apart from body text: semibold, with room above', () => {
    for (const tag of ['h4', 'h5', 'h6']) {
      const rules = rulesFor(`.oa-prose ${tag}`)
      expect(rules).toMatch(/font-weight:\s*600/)
      expect(rules).toMatch(/margin-top:/)
    }
  })

  it('never draws a heading fainter than the text under it', () => {
    for (const tag of ['h1', 'h2', 'h3', 'h4']) {
      expect(rulesFor(`.oa-prose ${tag}`)).not.toMatch(/color:\s*var\(--color-text-(2|muted)\)/)
    }
  })
})

describe('task lists', () => {
  it('drops the bullet in front of a checkbox item and gives the box the theme colour', () => {
    expect(css).toMatch(/\.oa-prose li:has\(> input\[type="checkbox"\]:first-child\)\s*\{[^}]*list-style:\s*none/)
    expect(css).toMatch(/\.oa-prose li > input\[type="checkbox"\]\s*\{[^}]*accent-color:\s*var\(--color-accent\)/)
  })
})
