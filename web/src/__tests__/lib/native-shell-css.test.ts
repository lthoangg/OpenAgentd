/**
 * Shell-only CSS that removes browser tells. happy-dom does not apply these
 * WebKit properties, so this guards the rules themselves.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

describe('long-press callout in the mobile shell', () => {
  it('turns the iOS link and image callout off for app chrome', () => {
    expect(css).toMatch(/html\[data-mobile-shell\] body\s*\{[^}]*-webkit-touch-callout:\s*none;/)
  })

  it('keeps it for content people open, save, or copy', () => {
    const optIn = css.match(/html\[data-mobile-shell\] :is\(([^)]*)\)\s*\{\s*-webkit-touch-callout:\s*default;/)
    expect(optIn).not.toBeNull()
    for (const selector of ['input', 'textarea', 'img', '.oa-prose', '.selectable-text', 'pre', 'code']) {
      expect(optIn?.[1]).toContain(selector)
    }
  })

  it('leaves browsers alone', () => {
    expect(css).not.toMatch(/(^|\n)\s*(html|body|\*)\s*\{[^}]*-webkit-touch-callout/)
  })
})

describe('dragging out of the desktop app', () => {
  it('does not drag icons, links, or images out of the window', () => {
    expect(css).toMatch(/html\[data-shell="desktop"\] :is\(img, a, svg\)\s*\{\s*-webkit-user-drag:\s*none;/)
  })
})
