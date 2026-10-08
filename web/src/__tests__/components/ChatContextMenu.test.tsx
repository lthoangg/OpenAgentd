/**
 * App right-click menus in the transcript (desktop app): links, code blocks,
 * assistant and user messages. The innermost surface wins, selected text
 * keeps the native menu, and Shift+F10 opens the app menu everywhere.
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
  it('offers Copy response and Copy as Markdown on an assistant message', async () => {
    renderAnswer('Some **bold** words')
    const paragraph = screen.getByText('bold').closest('p')!
    const event = fireEvent.contextMenu(paragraph)
    expect(event).toBe(false) // handled: no native menu
    expect(screen.getByRole('menu', { name: 'Actions for response' })).toBeTruthy()
    expect(items()).toEqual(['Copy response', 'Copy as Markdown'])

    await act(async () => { screen.getByRole('menuitem', { name: 'Copy as Markdown' }).click() })
    expect(writeText).toHaveBeenCalledWith('Some **bold** words')
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

  it('offers Copy code on a code block', async () => {
    renderAnswer('```ts\nconst a = 1\n```')
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Copy code' }).closest('[data-slot="code-block"]')!.querySelector('pre')!)
    expect(items()).toEqual(['Copy code'])
    await act(async () => { screen.getByRole('menuitem', { name: 'Copy code' }).click() })
    expect(writeText).toHaveBeenCalledWith('const a = 1')
  })

  it('offers Copy and Edit on a user message', async () => {
    const onEdit = mock(() => {})
    render(<UserBubble content="Fix the build" onEdit={onEdit} />)
    fireEvent.contextMenu(screen.getByText('Fix the build'))
    expect(items()).toEqual(['Copy', 'Edit'])
    await act(async () => { screen.getByRole('menuitem', { name: 'Edit' }).click() })
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('leaves selected text to the native menu', () => {
    render(<UserBubble content="Fix the build" />)
    const text = screen.getByText('Fix the build')
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection()!.addRange(range)
    expect(fireEvent.contextMenu(text)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the browser menu on right-click outside the desktop app, but Shift+F10 still opens the app menu', async () => {
    platform.isTauri = false
    renderAnswer('See [the docs](https://example.com/docs) here')
    const link = screen.getByRole('link', { name: 'the docs' })
    expect(fireEvent.contextMenu(link)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()

    act(() => link.focus())
    await act(async () => {
      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(items()).toEqual(['Open link', 'Copy link'])
  })
})
