import React from 'react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

// Pele itself measures text with canvas, which the test DOM lacks; this
// stand-in mounts like it does: through ``sanitize``, or reports the error.
const mounts: Array<{ source: string; options: Record<string, unknown> }> = []
mock.module('pele/lazy', () => ({
  mountAsync: async (element: HTMLElement, source: string, options: { sanitize: (svg: string) => Node }) => {
    mounts.push({ source, options: options as unknown as Record<string, unknown> })
    if (source.includes('BROKEN')) {
      return { result: undefined, error: new Error('Expected an arrow on line 2\n  A -- B'), destroy() {} }
    }
    element.replaceChildren(options.sanitize('<svg xmlns="http://www.w3.org/2000/svg" class="pele" role="graphics-document document"><script>x()</script><text onclick="x()">A</text></svg>'))
    return { result: { svg: '' }, error: undefined, destroy() {} }
  },
}))

import { MarkdownBlock } from '@/utils/markdown'

const source = ['flowchart LR', '  A --> B'].join('\n')
const diagram = ['```mermaid', source, '```'].join('\n')

afterEach(() => {
  cleanup()
  mounts.length = 0
})

describe('MarkdownBlock Mermaid fences', () => {
  it('draws a completed fence as a diagram, safely, with a Code view', async () => {
    render(<MarkdownBlock content={diagram} />)

    await waitFor(() => expect(document.querySelector('.oa-diagram svg.pele')).toBeTruthy())
    expect(mounts[0].source).toBe(source)
    expect(mounts[0].options).toMatchObject({ links: false, images: false })
    expect(document.querySelector('.oa-diagram script')).toBeNull()
    expect(document.querySelector('.oa-diagram text')?.getAttribute('onclick')).toBeNull()
    expect(document.querySelector('[data-slot="mermaid-block"] pre')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.getByRole('button', { name: 'Code' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-slot="mermaid-block"] pre')?.textContent).toBe(source)
  })

  it('draws a fence once it closes while the reply is still streaming', async () => {
    render(<MarkdownBlock content={`${diagram}\n\nStill explaining.`} isStreaming />)

    await waitFor(() => expect(document.querySelector('.oa-diagram svg.pele')).toBeTruthy())
    expect(screen.getByText('Still explaining.', { exact: false })).toBeTruthy()
  })

  it('keeps a fence that is still being written as code', () => {
    render(<MarkdownBlock content={['```mermaid', source].join('\n')} isStreaming />)

    expect(document.querySelector('[data-slot="mermaid-block"]')).toBeNull()
    expect(document.querySelector('pre')?.textContent).toContain('flowchart LR')
    expect(mounts).toHaveLength(0)
  })

  it('falls back to the code with the reason when the diagram cannot be drawn', async () => {
    render(<MarkdownBlock content={['```mermaid', 'flowchart LR', '  A BROKEN B', '```'].join('\n')} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Couldn’t draw this diagram: Expected an arrow on line 2')
    expect(screen.queryByRole('button', { name: 'Diagram' })).toBeNull()
    expect(document.querySelector('[data-slot="mermaid-block"] pre')?.textContent).toContain('A BROKEN B')
  })
})
