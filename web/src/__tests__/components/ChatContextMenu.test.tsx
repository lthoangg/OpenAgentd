/**
 * App right-click menus in the transcript: links only. Messages (yours and
 * the agent's) and code blocks keep the system menu. The innermost surface wins, selected text keeps the native
 * menu, and Shift+F10 opens the app menu everywhere. The browser gets the
 * same menu as the desktop app (touch: ``ChatContextMenu.touch.test.tsx``).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ContentBlock } from '@/api/types'

const platform = { isTauri: true, os: 'macos', isMacOverlay: false }
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => platform,
  getPlatform: () => platform,
}))
const { AgentView } = await import('@/components/AgentView')
const { UserBubble } = await import('@/components/AgentView/UserBubble')

const writeText = mock(async (..._args: unknown[]) => {})
beforeEach(() => {
  platform.isTauri = true
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

function renderAnswer(content: string) {
  const blocks: ContentBlock[] = [{ id: 'u1', type: 'user', content: 'Q' }, { id: 'a1', type: 'text', content }]
  return render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
}

const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent)

describe('chat right-click menus', () => {
  it('leaves an assistant message to the native menu: no app menu of its own', () => {
    renderAnswer('Some **bold** words')
    const paragraph = screen.getByText('bold').closest('p')!
    fireEvent.contextMenu(paragraph)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('gives a link its own menu instead of the message one', async () => {
    const open = mock(() => null)
    const original = window.open
    window.open = open as unknown as typeof window.open
    try {
      renderAnswer('See [the docs](https://example.com/docs) here')
      fireEvent.contextMenu(screen.getByRole('link', { name: 'the docs' }))
      expect(screen.getByRole('menu', { name: 'Actions for link https://example.com/docs' })).toBeTruthy()
      expect(items()).toEqual(['Open link', 'Copy link'])

      await act(async () => { screen.getByRole('menuitem', { name: 'Copy link' }).click() })
      expect(writeText).toHaveBeenCalledWith('https://example.com/docs')

      fireEvent.contextMenu(screen.getByRole('link', { name: 'the docs' }))
      await act(async () => { screen.getByRole('menuitem', { name: 'Open link' }).click() })
      expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
    } finally {
      window.open = original
    }
  })

  it('leaves a code block to the native menu; its header keeps Copy code', () => {
    renderAnswer('```ts\nconst a = 1\n```')
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Copy code' }).closest('[data-slot="code-block"]')!.querySelector('pre')!)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('leaves a user message to the native menu, and keeps its Copy and Edit buttons', () => {
    const onEdit = mock(() => {})
    render(<UserBubble content="Fix the build" onEdit={onEdit} />)
    fireEvent.contextMenu(screen.getByText('Fix the build'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy()
  })

  it('leaves a subagent report to the native menu', () => {
    render(<UserBubble content="All done" fromAgent="explorer#1" />)
    fireEvent.contextMenu(screen.getByText('All done'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the same app menu on right-click in a plain browser, and on Shift+F10', async () => {
    platform.isTauri = false
    renderAnswer('See [the docs](https://example.com/docs) here')
    const link = screen.getByRole('link', { name: 'the docs' })
    expect(fireEvent.contextMenu(link)).toBe(false)
    expect(screen.getByRole('menu', { name: 'Actions for link https://example.com/docs' })).toBeTruthy()
    expect(items()).toEqual(['Open link', 'Copy link'])

    // Escape closes it, so the key path starts from a clean page.
    await act(async () => {
      screen.getByRole('menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(screen.queryByRole('menu')).toBeNull()

    act(() => link.focus())
    await act(async () => {
      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(items()).toEqual(['Open link', 'Copy link'])
  })
})
