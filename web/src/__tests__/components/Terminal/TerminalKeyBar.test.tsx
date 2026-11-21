import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TerminalKeyBar } from '@/components/Terminal/TerminalKeyBar'

afterEach(cleanup)

function renderBar(overrides: Partial<{
  onKey: (data: string) => void
  ctrlArmed: boolean
  onCtrlToggle: () => void
  typing: boolean
  lineOn: boolean
  onLineToggle: () => void
  onShowKeyboard: () => void
  onHideKeyboard: () => void
  onMore: () => void
}> = {}) {
  const props = {
    onKey: mock(() => {}),
    onCtrlToggle: mock(() => {}),
    onLineToggle: mock(() => {}),
    onShowKeyboard: mock(() => {}),
    onHideKeyboard: mock(() => {}),
    onMore: mock(() => {}),
    ...overrides,
  }
  render(
    <TerminalKeyBar
      {...props}
      ctrlArmed={overrides.ctrlArmed ?? false}
      typing={overrides.typing ?? true}
      lineOn={overrides.lineOn ?? false}
    />,
  )
  return props
}

/** Each key's visible label, or its name for icon keys, in bar order. */
const keyOrder = () =>
  Array.from(screen.getByRole('toolbar').querySelectorAll('button')).map(
    (button) => button.getAttribute('aria-label') ?? button.textContent,
  )

describe('TerminalKeyBar', () => {
  it('typing: Line, Esc, Tab, Ctrl, ^C, the four arrows and More, in one row that never scrolls', () => {
    renderBar({ typing: true })
    expect(keyOrder()).toEqual([
      'Command line field', 'Esc', 'Tab', 'Ctrl', 'Send Ctrl+C (interrupt)',
      'Arrow left', 'Arrow up', 'Arrow down', 'Arrow right', 'More keys',
    ])
    expect(screen.getByRole('toolbar').className).not.toContain('overflow-x')
  })

  it('reading (keyboard down): what answers a prompt, with Enter and a way back to the keyboard', () => {
    renderBar({ typing: false })
    expect(keyOrder()).toEqual([
      'Show keyboard', 'Esc', 'Tab', 'Send Ctrl+C (interrupt)', 'Arrow up', 'Arrow down', 'Enter', 'More keys',
    ])
  })

  it('sends each key as its bytes', () => {
    const onKey = mock(() => {})
    renderBar({ onKey, typing: false })
    fireEvent.click(screen.getByText('Esc'))
    fireEvent.click(screen.getByText('Tab'))
    fireEvent.click(screen.getByLabelText('Send Ctrl+C (interrupt)'))
    fireEvent.click(screen.getByLabelText('Enter'))
    fireEvent.click(screen.getByLabelText('Arrow up'))
    expect(onKey.mock.calls.map(([seq]) => seq)).toEqual(['\x1b', '\t', '\x03', '\r', '\x1b[A'])
  })

  it('an arrow held repeats', async () => {
    const onKey = mock(() => {})
    renderBar({ onKey })
    const left = screen.getByLabelText('Arrow left')
    fireEvent.pointerDown(left, { pointerType: 'touch' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 450)))
    fireEvent.pointerUp(left, { pointerType: 'touch' })
    fireEvent.click(left)
    expect(onKey.mock.calls.length).toBeGreaterThan(1)
    expect(onKey.mock.calls.every(([seq]) => seq === '\x1b[D')).toBe(true)
  })

  it('Ctrl reports its armed state with one fill and fires its toggle', () => {
    const onCtrlToggle = mock(() => {})
    renderBar({ ctrlArmed: true, onCtrlToggle })
    const ctrl = screen.getByRole('button', { name: 'Ctrl' })
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')
    expect(ctrl.className).toContain('bg-(--color-fill-selected)')
    expect(ctrl.className).not.toContain('bg-(--color-surface-2)')
    fireEvent.click(ctrl)
    expect(onCtrlToggle).toHaveBeenCalledTimes(1)
  })

  it('Line shows whether the field is on and toggles it without sending a key', () => {
    const props = renderBar({ lineOn: true })
    const line = screen.getByRole('button', { name: 'Command line field' })
    expect(line.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(line)
    expect(props.onLineToggle).toHaveBeenCalledTimes(1)
    expect(props.onKey).not.toHaveBeenCalled()
  })

  it('More and Show keyboard call their handlers', () => {
    const props = renderBar({ typing: false })
    fireEvent.click(screen.getByLabelText('More keys'))
    fireEvent.click(screen.getByLabelText('Show keyboard'))
    expect(props.onMore).toHaveBeenCalledTimes(1)
    expect(props.onShowKeyboard).toHaveBeenCalledTimes(1)
  })

  it('a swipe down the bar puts the keyboard away, and the key under the finger does not fire', () => {
    const props = renderBar({ typing: true })
    const esc = screen.getByText('Esc')
    fireEvent.pointerDown(esc, { pointerType: 'touch', clientX: 100, clientY: 10 })
    fireEvent.pointerMove(esc, { pointerType: 'touch', clientX: 102, clientY: 50 })
    fireEvent.pointerUp(esc, { pointerType: 'touch' })
    fireEvent.click(esc)
    expect(props.onHideKeyboard).toHaveBeenCalledTimes(1)
    expect(props.onKey).not.toHaveBeenCalled()
  })

  it('a sideways drag is not a swipe down', () => {
    const props = renderBar({ typing: true })
    const bar = screen.getByRole('toolbar')
    fireEvent.pointerDown(bar, { pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerMove(bar, { pointerType: 'touch', clientX: 90, clientY: 40 })
    expect(props.onHideKeyboard).not.toHaveBeenCalled()
  })

  it('opts out of edge swipe and of the browser panning it', () => {
    renderBar()
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar.getAttribute('data-swipe-ignore')).not.toBeNull()
    expect(toolbar.className).toContain('touch-none')
  })
})
