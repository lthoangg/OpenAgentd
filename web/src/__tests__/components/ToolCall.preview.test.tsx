import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ToolCall } from '@/components/ToolCall'
import { OPEN_PREVIEW_EVENT, isPreviewTarget, previewTargetFromArgs } from '@/components/Preview/preview-events'
import { selectFinishedPreviewCalls, usePreviewToolAutoOpen } from '@/components/AgentChatView/usePreviewToolAutoOpen'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

afterEach(cleanup)

const OPENED = "Opening http://localhost:5173/pricing in the user's Preview tab (served at http://127.0.0.1:52011/pricing)."

function header(title: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[title]')).find((node) => node.getAttribute('title') === title)
}

describe('preview tool card', () => {
  it('names the page or the console it reads', () => {
    render(<ToolCall name="preview" args={JSON.stringify({ action: 'open', url: 'http://localhost:5173/pricing' })} />)
    expect(header('preview: localhost:5173/pricing')).toBeTruthy()
    cleanup()
    render(<ToolCall name="preview" args={JSON.stringify({ action: 'logs', level: 'error' })} />)
    expect(header('preview: Console errors')).toBeTruthy()
  })

  it('names page actions and offers no Open button for them', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ action: 'snapshot' }, 'Page snapshot'],
      [{ action: 'click', ref: 'e3' }, 'Click e3'],
      [{ action: 'fill', selector: '#email', value: 'x' }, 'Fill #email'],
      [{ action: 'press', key: 'Enter' }, 'Press Enter'],
      [{ action: 'navigate', to: '/pricing' }, 'Go to /pricing'],
      [{ action: 'wait', text: 'Saved', gone: true }, 'Wait for "Saved" to go'],
      [{ action: 'scroll', to: 'bottom' }, 'Scroll to bottom'],
      [{ action: 'chain' }, 'Chain'],
      [{ action: 'chain', steps: [{ action: 'fill', ref: 'e1', value: 'x' }, { action: 'click', ref: 'e4' }] }, 'Fill e1 → Click e4'],
    ]
    for (const [args, label] of cases) {
      render(<ToolCall name="preview" args={JSON.stringify(args)} done result="Clicked <button>. Page is now /." />)
      expect(header(`preview: ${label}`)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
      cleanup()
    }
  })

  it('shortens long chains in the header and keeps every step in its title', () => {
    const steps = [{ action: 'fill', ref: 'e1' }, { action: 'fill', ref: 'e2' }, { action: 'click', ref: 'e4' }, { action: 'wait', text: 'Saved' }, { action: 'snapshot' }]
    render(<ToolCall name="preview" args={JSON.stringify({ action: 'chain', steps })} />)
    const node = header('preview: Fill e1 → Fill e2 → Click e4 → Wait for "Saved" → Page snapshot')
    expect(node?.textContent).toContain('Fill e1 → Fill e2 → Click e4 +2 more')
  })

  it('offers Open preview once the page opened, and asks the shell for it', () => {
    const seen: unknown[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_PREVIEW_EVENT, listener)
    const args = JSON.stringify({ action: 'open', url: 'http://localhost:5173/pricing' })
    const { rerender } = render(<ToolCall name="preview" args={args} />)
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
    rerender(<ToolCall name="preview" args={args} done result="The preview needs a project workspace." />)
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
    rerender(<ToolCall name="preview" args={args} done result={OPENED} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    window.removeEventListener(OPEN_PREVIEW_EVENT, listener)
    expect(seen).toEqual([{ kind: 'url', url: 'http://localhost:5173/pricing' }])
  })
})

describe('preview tool targets', () => {
  it('reads open calls only', () => {
    expect(previewTargetFromArgs(JSON.stringify({ action: 'open', path: './designs/a.html' }))).toEqual({ kind: 'file', path: 'designs/a.html' })
    expect(previewTargetFromArgs(JSON.stringify({ action: 'logs', url: 'http://localhost:1' }))).toBeNull()
    expect(previewTargetFromArgs('{not json')).toBeNull()
    expect(isPreviewTarget({ kind: 'url', url: 'x' })).toBe(true)
    expect(isPreviewTarget({ kind: 'file' })).toBe(false)
  })
})

function previewBlock(id: string, overrides: Partial<ContentBlock> = {}): ContentBlock {
  return {
    id,
    type: 'tool',
    content: '',
    toolName: 'preview',
    toolCallId: id,
    toolArgs: JSON.stringify({ action: 'open', url: 'http://localhost:5173/' }),
    toolDone: true,
    toolResult: OPENED,
    startedAt: Date.now(),
    ...overrides,
  }
}

function setBlocks(currentBlocks: ContentBlock[], blocks: ContentBlock[] = []) {
  const base = useAgentStore.getState().agentStreams.lead
  useAgentStore.setState({ agentStreams: { lead: { ...(base ?? {}), blocks, currentBlocks } as never } })
}

describe('usePreviewToolAutoOpen', () => {
  it('opens pages the agent opens live, once each, and skips history', () => {
    setBlocks([], [previewBlock('old')])
    const onOpen = mock(() => {})
    renderHook(() => usePreviewToolAutoOpen({ enabled: true, onOpen }))
    expect(onOpen).not.toHaveBeenCalled()

    act(() => setBlocks([previewBlock('running', { toolDone: false })], [previewBlock('old')]))
    expect(onOpen).not.toHaveBeenCalled()
    act(() => setBlocks([previewBlock('running')], [previewBlock('old')]))
    expect(onOpen).toHaveBeenCalledTimes(1)
    act(() => setBlocks([], [previewBlock('old'), previewBlock('running')]))
    expect(onOpen).toHaveBeenCalledTimes(1)

    act(() => setBlocks([previewBlock('failed', { toolResult: 'Only local servers can be previewed.' }), previewBlock('stale', { startedAt: undefined })]))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('does nothing while disabled', () => {
    setBlocks([])
    const onOpen = mock(() => {})
    renderHook(() => usePreviewToolAutoOpen({ enabled: false, onOpen }))
    act(() => setBlocks([previewBlock('live')]))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('selects finished preview calls only', () => {
    const calls = selectFinishedPreviewCalls({ agentStreams: { a: { currentBlocks: [previewBlock('x'), previewBlock('y', { toolDone: false }), previewBlock('z', { toolName: 'shell' })] } } })
    expect(calls.map((b) => b.id)).toEqual(['x'])
    expect(selectFinishedPreviewCalls({})).toEqual([])
  })
})
