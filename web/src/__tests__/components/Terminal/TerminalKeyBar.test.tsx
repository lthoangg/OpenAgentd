import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TerminalKeyBar } from '@/components/Terminal/TerminalKeyBar'

afterEach(cleanup)

function renderBar(overrides?: {
  onKey?: (data: string) => void
  onPaste?: () => void
  ctrlArmed?: boolean
  onCtrlToggle?: () => void
  altArmed?: boolean
  onAltToggle?: () => void
  lineOn?: boolean
  onLineToggle?: () => void
}) {
  const onKey = overrides?.onKey ?? mock(() => {})
  const onPaste = overrides?.onPaste ?? mock(() => {})
  const onCtrlToggle = overrides?.onCtrlToggle ?? mock(() => {})
  const onAltToggle = overrides?.onAltToggle ?? mock(() => {})
  const onLineToggle = overrides?.onLineToggle ?? mock(() => {})
  render(
    <TerminalKeyBar
      onKey={onKey}
      onPaste={onPaste}
      ctrlArmed={overrides?.ctrlArmed ?? false}
      onCtrlToggle={onCtrlToggle}
      altArmed={overrides?.altArmed ?? false}
      onAltToggle={onAltToggle}
      lineOn={overrides?.lineOn ?? false}
      onLineToggle={onLineToggle}
    />,
  )
  return { onKey, onPaste, onCtrlToggle, onAltToggle, onLineToggle }
}

/** Each key's visible label, or its name for icon keys, in bar order. */
const keyOrder = () =>
  Array.from(screen.getByRole('toolbar').querySelectorAll('button')).map(
    (button) => button.textContent || button.getAttribute('aria-label'),
  )

describe('TerminalKeyBar', () => {
  it('puts the keys a shell needs most first: Esc, Ctrl, Alt, Tab, ^C, then the arrows', () => {
    renderBar()
    expect(keyOrder()).toEqual([
      'Line',
      'Esc', 'Ctrl', 'Alt', 'Tab', '^C',
      'Arrow left', 'Arrow up', 'Arrow down', 'Arrow right',
      '|', '/', '~', '-',
      'Home', 'End', 'PgUp', 'PgDn',
      '^D', '^L', '^R', 'Paste',
    ])
  })

  it('sends Esc and Tab escape sequences', () => {
    const onKey = mock(() => {})
    renderBar({ onKey })
    fireEvent.click(screen.getByText('Esc'))
    expect(onKey).toHaveBeenCalledWith('\x1b')
    fireEvent.click(screen.getByText('Tab'))
    expect(onKey).toHaveBeenCalledWith('\t')
  })

  it('sends arrow-key sequences', () => {
    const onKey = mock(() => {})
    renderBar({ onKey })
    fireEvent.click(screen.getByLabelText('Arrow up'))
    expect(onKey).toHaveBeenCalledWith('\x1b[A')
    fireEvent.click(screen.getByLabelText('Arrow left'))
    expect(onKey).toHaveBeenCalledWith('\x1b[D')
  })

  it('sends Home, End, PgUp and PgDn', () => {
    const onKey = mock(() => {})
    renderBar({ onKey })
    for (const name of ['Home', 'End', 'PgUp', 'PgDn']) fireEvent.click(screen.getByRole('button', { name }))
    expect(onKey.mock.calls.map(([seq]) => seq)).toEqual(['\x1b[H', '\x1b[F', '\x1b[5~', '\x1b[6~'])
  })

  it('Ctrl and Alt report their armed state and fire their toggles', () => {
    const onCtrlToggle = mock(() => {})
    const onAltToggle = mock(() => {})
    renderBar({ ctrlArmed: true, altArmed: false, onCtrlToggle, onAltToggle })
    expect(screen.getByText('Ctrl').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Alt').getAttribute('aria-pressed')).toBe('false')
    // One fill per key: the armed one alone, so it cannot lose to the plain one.
    expect(screen.getByText('Ctrl').className).toContain('bg-(--color-fill-selected)')
    expect(screen.getByText('Ctrl').className).not.toContain('bg-(--color-surface-2)')
    expect(screen.getByText('Alt').className).toContain('bg-(--color-surface-2)')
    fireEvent.click(screen.getByText('Ctrl'))
    fireEvent.click(screen.getByText('Alt'))
    expect(onCtrlToggle).toHaveBeenCalledTimes(1)
    expect(onAltToggle).toHaveBeenCalledTimes(1)
  })

  it('sends Ctrl+C / Ctrl+D / Ctrl+L / Ctrl+R via quick-action buttons', () => {
    const onKey = mock(() => {})
    renderBar({ onKey })
    fireEvent.click(screen.getByLabelText('Send Ctrl+C (interrupt)'))
    fireEvent.click(screen.getByLabelText('Send Ctrl+D (EOF)'))
    fireEvent.click(screen.getByLabelText('Send Ctrl+L (clear screen)'))
    fireEvent.click(screen.getByLabelText('Send Ctrl+R (search history)'))
    expect(onKey.mock.calls.map(([seq]) => seq)).toEqual(['\x03', '\x04', '\x0c', '\x12'])
  })

  it('asks the terminal to paste instead of typing the clipboard as keys', () => {
    const onKey = mock(() => {})
    const onPaste = mock(() => {})
    renderBar({ onKey, onPaste })
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(onKey).not.toHaveBeenCalled()
  })

  it('has the command line switch first, pinned, showing whether the field is on', () => {
    const onLineToggle = mock(() => {})
    const onKey = mock(() => {})
    renderBar({ lineOn: true, onLineToggle, onKey })
    const line = screen.getByRole('button', { name: 'Command line field' })
    expect(line.getAttribute('aria-pressed')).toBe('true')
    expect(line.className).toContain('sticky')
    fireEvent.click(line)
    expect(onLineToggle).toHaveBeenCalledTimes(1)
    expect(onKey).not.toHaveBeenCalled()
  })

  it('opts out of edge swipe via data-swipe-ignore', () => {
    renderBar()
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar.getAttribute('data-swipe-ignore')).not.toBeNull()
  })
})
