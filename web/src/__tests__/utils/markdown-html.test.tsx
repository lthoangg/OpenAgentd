/**
 * `MarkdownBlock allowHtml` (workspace Markdown files) renders raw HTML
 * through the allowlist; everywhere else (agent replies) tags stay text.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

import { MarkdownBlock } from '@/utils/markdown'

afterEach(cleanup)

const README = '<p align="center"><img src="logo.png" alt="Logo"></p>\n\nUse <kbd>Ctrl</kbd> and <img src="badge.svg" alt="badge"> here.'

describe('MarkdownBlock raw HTML', () => {
  it('keeps HTML in an agent reply as text', () => {
    const { container } = render(<MarkdownBlock content={README} />)
    expect(container.textContent).toContain('<p align="center">')
    expect(container.querySelector('p[align]')).toBeNull()
  })

  it('renders it for a workspace file, block and inline, resolving images through the file', () => {
    const { container } = render(<MarkdownBlock content={README} allowHtml resolveMediaSrc={(src) => `/files/${src}`} />)
    expect(container.textContent).not.toContain('<')
    expect(container.querySelector('p[align="center"] img')?.getAttribute('src')).toBe('/files/logo.png')
    expect(container.querySelector('img[alt="badge"]')?.getAttribute('src')).toBe('/files/badge.svg')
    expect(container.textContent).toContain('Use Ctrl and')
  })
})
