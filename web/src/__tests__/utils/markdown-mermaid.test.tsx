import React from 'react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const initializeMermaid = mock(() => undefined)
let renderError: Error | undefined
const renderMermaid = mock(async (...args: unknown[]) => ({
  svg: `<svg role="img" aria-label="Rendered Mermaid diagram"><text>${String(args[1])}</text></svg>`,
}))

mock.module('mermaid', () => ({
  default: {
    initialize: initializeMermaid,
    render: renderMermaid,
  },
}))

import { MarkdownBlock } from '@/utils/markdown'
import { clearSvgCache } from '@/utils/MermaidBlock'

const source = ['flowchart LR', '  A --> B'].join('\n')
const diagram = ['```mermaid', source, '```'].join('\n')

afterEach(cleanup)

beforeEach(() => {
  renderError = undefined
  clearSvgCache()
  initializeMermaid.mockClear()
  renderMermaid.mockClear()
  renderMermaid.mockImplementation(async (...args: unknown[]) => ({
    svg: renderError
      ? await Promise.reject(renderError)
      : `<svg role="img" aria-label="Rendered Mermaid diagram"><text>${String(args[1])}</text></svg>`,
  }))
})

describe('MarkdownBlock Mermaid fences', () => {
  it('renders a completed Mermaid fence as a diagram by default', async () => {
    render(<MarkdownBlock content={diagram} />)

    expect(screen.getByRole('tab', { name: 'Diagram' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('img', { name: 'Rendered Mermaid diagram' })).toBeTruthy()
    expect(initializeMermaid).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: expect.any(Object),
    })
    expect(renderMermaid.mock.calls[0]?.[1]).toBe(source)
  })

  it('switches to the original code and retains its copy action', async () => {
    const writeText = mock(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<MarkdownBlock content={diagram} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Code' }))

    const code = document.querySelector('code')
    expect(code?.textContent).toBe(source)
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source))
  })

  it('renders a completed Mermaid fence while later prose is streaming', async () => {
    render(<MarkdownBlock content={`${diagram}\n\nStill explaining the diagram.`} isStreaming />)

    expect(await screen.findByRole('img', { name: 'Rendered Mermaid diagram' })).toBeTruthy()
    expect(screen.getByText('Still explaining the diagram.')).toBeTruthy()
  })

  it('keeps an unclosed Mermaid fence as code while the response is streaming', () => {
    render(<MarkdownBlock content={['```mermaid', source].join('\n')} isStreaming />)

    expect(screen.queryByRole('tab', { name: 'Diagram' })).toBeNull()
    expect(screen.getByText('mermaid')).toBeTruthy()
    expect(screen.getByText(/flowchart LR/).closest('pre')).toBeTruthy()
  })

  it('renders every completed Mermaid fence while the response is streaming', async () => {
    const secondSource = ['sequenceDiagram', '  Alice->>Bob: Hello'].join('\n')
    const secondDiagram = ['```mermaid', secondSource, '```'].join('\n')
    render(<MarkdownBlock content={`${diagram}\n\n${secondDiagram}\n\nMore prose.`} isStreaming />)

    await waitFor(() => expect(screen.getAllByRole('img', { name: 'Rendered Mermaid diagram' })).toHaveLength(2))
    expect(screen.getByText('More prose.')).toBeTruthy()
  })

  it('keeps the Mermaid code fallback when a completed streaming fence is invalid', async () => {
    renderError = new Error('parser internals')
    render(<MarkdownBlock content={`${diagram}\n\nStill explaining the diagram.`} isStreaming />)

    expect((await screen.findByRole('alert')).textContent).toContain('Could not render this Mermaid diagram')
    expect(screen.queryByText('parser internals')).toBeNull()
    expect(document.querySelector('pre')?.textContent).toContain(source)
  })

  it('shows the source and a concise error when Mermaid rejects the diagram', async () => {
    renderError = new Error('parser internals')
    render(<MarkdownBlock content={diagram} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Could not render this Mermaid diagram')
    expect(screen.queryByText('parser internals')).toBeNull()
    expect(document.querySelectorAll('code').length).toBeGreaterThan(0)
  })

  it('keeps non-Mermaid fences on the regular code path', () => {
    render(<MarkdownBlock content={['```ts', 'const answer = 42', '```'].join('\n')} />)

    expect(screen.queryByRole('tab', { name: 'Diagram' })).toBeNull()
    expect(screen.getByText('ts')).toBeTruthy()
    expect(document.querySelector('pre')?.textContent).toContain('const answer = 42')
  })
})
