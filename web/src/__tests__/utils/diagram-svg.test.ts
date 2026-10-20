import { describe, expect, it } from 'bun:test'
import { sanitizeDiagramSvg } from '@/utils/diagram-svg'

const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="pele" onload="x()">${inner}</svg>`

function clean(inner: string): Element {
  return sanitizeDiagramSvg(wrap(inner)) as Element
}

describe('sanitizeDiagramSvg', () => {
  it('keeps drawing elements and in-document references', () => {
    const svg = clean('<defs><marker id="m"><path d="M0 0"/></marker></defs><path d="M1 1" marker-end="url(#m)"/><use href="#m"/><text x="1">Hi</text>')
    expect(svg.localName).toBe('svg')
    expect(svg.getAttribute('class')).toBe('pele')
    expect(svg.querySelector('marker path')).toBeTruthy()
    expect(svg.querySelector('use')?.getAttribute('href')).toBe('#m')
    expect(svg.querySelector('text')?.textContent).toBe('Hi')
  })

  it('drops scripts, embeds, animation, handlers and outside references', () => {
    const svg = clean(
      '<script>alert(1)</script><foreignObject><div>x</div></foreignObject><image href="https://x/y.png"/>'
      + '<rect onclick="x()" onmouseover="x()" width="1"/><use href="https://x/s.svg#a"/><use xlink:href="javascript:alert(1)"/>'
      + '<animate attributeName="href" to="javascript:alert(1)"/><set attributeName="href" to="x"/>'
      + '<a href="javascript:alert(1)"><text>label</text></a>',
    )
    const html = svg.outerHTML
    for (const banned of ['<script', 'foreignObject', '<image', 'onclick', 'onmouseover', 'onload', 'javascript:', 'https://', '<animate', '<set', '<a ']) {
      expect(html).not.toContain(banned)
    }
    expect(svg.querySelector('rect')?.getAttribute('width')).toBe('1')
    expect(svg.querySelector('text')?.textContent).toBe('label')
  })

  it('returns an empty svg for markup that is not one svg document', () => {
    for (const markup of ['<div>no</div>', '<svg><g></svg']) {
      const svg = sanitizeDiagramSvg(markup) as Element
      expect(svg.localName).toBe('svg')
      expect(svg.childNodes).toHaveLength(0)
    }
  })
})
