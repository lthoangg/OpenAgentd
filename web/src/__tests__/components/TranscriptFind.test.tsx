/**
 * Find in session (⌘F): counts matches in the transcript on screen, steps
 * through them with Enter / Shift+Enter, and closes on Escape.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TranscriptFind } from '@/components/TranscriptFind'

afterEach(cleanup)

function renderFind(onClose = () => {}) {
  return render(
    <div id="main">
      <div className="oa-chat-scroll">
        <p>The pool rotates keys.</p>
        <p>A pinned session never rotates: the POOL waits.</p>
      </div>
      <TranscriptFind onClose={onClose} />
    </div>,
  )
}

describe('TranscriptFind', () => {
  it('counts matches in the transcript, ignoring case', () => {
    renderFind()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in session' }), { target: { value: 'pool' } })
    expect(screen.getByRole('status').textContent).toBe('1 of 2')
  })

  it('steps forward with Enter and back with Shift+Enter, wrapping around', () => {
    renderFind()
    const input = screen.getByRole('searchbox', { name: 'Find in session' })
    fireEvent.change(input, { target: { value: 'rotate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('status').textContent).toBe('2 of 2')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('status').textContent).toBe('1 of 2')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('2 of 2')
  })

  it('says so when nothing matches', () => {
    renderFind()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in session' }), { target: { value: 'quota' } })
    expect(screen.getByRole('status').textContent).toBe('No results')
  })

  it('closes on Escape and from its close button', () => {
    const onClose = mock(() => {})
    renderFind(onClose)
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Find in session' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
