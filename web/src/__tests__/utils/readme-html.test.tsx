/**
 * Raw HTML in a workspace Markdown file (a README's centred logo, badges,
 * <picture>, <details>) renders as React elements from an allowlist: no
 * innerHTML, nothing active, relative images through the file's resolver.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

import { renderSafeHtml } from '@/utils/readme-html'

afterEach(cleanup)

const resolveSrc = (src: string) => `/files/docs/${src}`

function show(html: string) {
  return render(<div data-testid="out">{renderSafeHtml(html, { resolveSrc })}</div>).getByTestId('out')
}

describe('renderSafeHtml', () => {
  it('keeps a centred logo: alignment, size and alt, with a relative src resolved', () => {
    const out = show('<p align="center"><img src="logo.png" width="120" alt="Logo"></p>')
    const p = out.querySelector('p') as HTMLElement
    expect(p.getAttribute('align')).toBe('center')
    const img = p.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/files/docs/logo.png')
    expect(img.getAttribute('width')).toBe('120')
    expect(img.getAttribute('alt')).toBe('Logo')
  })

  it('drops scripts, styles, frames and event handlers, and unsafe links', () => {
    const out = show([
      '<script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe>',
      '<p onclick="alert(1)" style="color:red">text</p>',
      '<a href="javascript:alert(1)">bad</a> <a href="https://example.com">good</a>',
      '<img src="javascript:alert(1)" onerror="alert(1)">',
    ].join(''))
    expect(out.innerHTML).not.toMatch(/script|style=|iframe|onclick|onerror|javascript:/i)
    expect(out.textContent).toContain('text')
    expect(out.textContent).toContain('bad')
    expect(out.querySelector('a[href="https://example.com"]')?.textContent).toBe('good')
    expect(out.querySelector('img')).toBeNull()
  })

  it('resolves each source of a <picture>, and keeps its media query', () => {
    const out = show('<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png 1x, dark@2x.png 2x"><img src="light.png" alt="x"></picture>')
    const source = out.querySelector('picture > source') as HTMLElement
    expect(source.getAttribute('srcset')).toBe('/files/docs/dark.png 1x, /files/docs/dark@2x.png 2x')
    expect(source.getAttribute('media')).toBe('(prefers-color-scheme: dark)')
    expect(out.querySelector('picture > img')?.getAttribute('src')).toBe('/files/docs/light.png')
  })

  it('keeps <details> and <summary>, and unwraps tags it does not know', () => {
    const out = show('<details><summary>More</summary>Body <font color="red">here</font></details><center>mid</center>')
    expect(out.querySelector('details > summary')?.textContent).toBe('More')
    expect(out.querySelector('font')).toBeNull()
    expect(out.textContent).toContain('Body here')
    expect(out.querySelector('div[align="center"]')?.textContent).toBe('mid')
  })
})
