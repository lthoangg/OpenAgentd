import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'

import { TerminalKeyBar } from '@/components/Terminal/TerminalKeyBar'

function renderBar(overrides?: {
  onKey?: (data: string) => void
  ctrlArmed?: boolean
  onCtrlToggle?: () => void
}) {
  const onKey = overrides?.onKey ?? mock(() => {})
  const onCtrlToggle = overrides?.onCtrlToggle ?? mock(() => {})
  render(
    <TerminalKeyBar
      onKey={onKey}
      ctrlArmed={overrides?.ctrlArmed ?? false}
      onCtrlToggle={onCtrlToggle}
    />,
  )
  return { onKey, onCtrlToggle }
}

describe('TerminalKeyBar', () => {
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

  it('Ctrl button reports pressed state and fires toggle', () => {
    const onCtrlToggle = mock(() => {})
    renderBar({ ctrlArmed: true, onCtrlToggle })
    const ctrl = screen.getByText('Ctrl')
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(ctrl)
    expect(onCtrlToggle).toHaveBeenCalledTimes(1)
  })

  it('Ctrl button shows unpressed state when disarmed', () => {
    renderBar({ ctrlArmed: false })
    expect(screen.getByText('Ctrl').getAttribute('aria-pressed')).toBe('false')
  })

  it('sends Ctrl+C / Ctrl+D / Ctrl+L via quick-action buttons', () => {
    const onKey = mock(() => {})
    renderBar({ onKey })
    fireEvent.click(screen.getByLabelText('Send Ctrl+C (interrupt)'))
    expect(onKey).toHaveBeenCalledWith('\x03')
    fireEvent.click(screen.getByLabelText('Send Ctrl+D (EOF)'))
    expect(onKey).toHaveBeenCalledWith('\x04')
    fireEvent.click(screen.getByLabelText('Send Ctrl+L (clear screen)'))
    expect(onKey).toHaveBeenCalledWith('\x0c')
  })

  it('opts out of edge swipe via data-swipe-ignore', () => {
    renderBar()
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar.getAttribute('data-swipe-ignore')).not.toBeNull()
  })
})
