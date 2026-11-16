import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TerminalActionSheet } from '@/components/Terminal/TerminalActionSheet'
import type { TerminalMenuAction } from '@/components/Terminal/terminal-menu'

afterEach(cleanup)

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-action-sheet-item]'))

function renderSheet(overrides: { open?: boolean; hasSelection?: boolean; onAction?: (action: TerminalMenuAction) => void; onClose?: () => void } = {}) {
  const onAction = overrides.onAction ?? mock(() => {})
  const onClose = overrides.onClose ?? mock(() => {})
  render(
    <TerminalActionSheet
      open={overrides.open ?? true}
      onClose={onClose}
      hasSelection={overrides.hasSelection ?? true}
      os="ios"
      onAction={onAction}
    />,
  )
  return { onAction, onClose }
}

describe('TerminalActionSheet', () => {
  it('is the shared phone action sheet, with Select Text first', () => {
    renderSheet()
    expect(document.querySelector('[data-action-sheet]')).toBeTruthy()
    expect(rows().map((row) => row.textContent)).toEqual([
      'Select Text', 'Copy', 'Paste', 'Select All', 'Find', 'Add to chat', 'Clear',
    ])
  })

  it('disables Copy and Add to chat without a selection', () => {
    renderSheet({ hasSelection: false })
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select Text' })).not.toBeDisabled()
  })

  it('closes, then runs the chosen action', () => {
    const { onAction, onClose } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Select Text' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('select-text')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onAction).toHaveBeenCalledWith('clear')
  })

  it('renders nothing when closed', () => {
    renderSheet({ open: false })
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull()
  })
})
