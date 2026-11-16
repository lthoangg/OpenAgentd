import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TerminalTextView } from '@/components/Terminal/TerminalTextView'
import { onComposerInsert } from '@/lib/composer-insert'

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function renderView(lines: string[], viewportLine = 0, onClose = mock(() => {})) {
  render(<TerminalTextView text={{ lines, viewportLine }} fontFamily="monospace" fontSize={13} onClose={onClose} />)
  return { onClose }
}

/** Select lines ``from``..``to`` the way a finger would: a native range. */
function selectLines(from: number, to: number) {
  const root = screen.getByTestId('terminal-text')
  const start = root.querySelector(`[data-line="${from}"]`)!
  const end = root.querySelector(`[data-line="${to}"]`)!
  const range = document.createRange()
  range.setStart(start.firstChild!, 0)
  range.setEnd(end.firstChild!, end.textContent!.length)
  act(() => {
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

describe('TerminalTextView', () => {
  it('shows each line as selectable text', () => {
    renderView(['$ make', 'ok'])
    const root = screen.getByTestId('terminal-text')
    expect(root).toHaveClass('selectable-text')
    expect(root.querySelectorAll('[data-line]')).toHaveLength(2)
    expect(root.querySelector('[data-line="1"]')).toHaveTextContent('ok')
  })

  it('opens scrolled to the line the terminal was showing', () => {
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        return Number(this.dataset.line ?? 0) * 18
      },
    })
    try {
      renderView(['a', 'b', 'c', 'd'], 3)
      const scroller = screen.getByTestId('terminal-text').parentElement!
      expect(scroller.scrollTop).toBe(54)
    } finally {
      if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop)
    }
  })

  it('disables Copy and Add to chat until text is selected', () => {
    renderView(['a', 'b'])
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeDisabled()
    selectLines(0, 1)
    expect(screen.getByRole('button', { name: 'Copy' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add to chat' })).not.toBeDisabled()
  })

  it('copies the native selection', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text) } },
    })
    renderView(['first', 'second', 'third'])
    selectLines(1, 1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(written).toEqual(['second'])
  })

  it('adds the native selection to the chat and closes', () => {
    const inserted: string[] = []
    const off = onComposerInsert((text) => inserted.push(text))
    try {
      const { onClose } = renderView(['$ test', 'FAILED x', 'done'])
      selectLines(1, 1)
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
      expect(inserted).toEqual(['Terminal output:\n```text\nFAILED x\n```'])
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it('closes on Done', () => {
    const { onClose } = renderView(['a'])
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
