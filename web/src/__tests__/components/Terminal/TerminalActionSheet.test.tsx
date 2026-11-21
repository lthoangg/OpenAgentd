import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TerminalActionSheet } from '@/components/Terminal/TerminalActionSheet'
import type { TerminalMenuAction } from '@/components/Terminal/terminal-menu'

afterEach(cleanup)

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-action-sheet-item]'))

function renderSheet(overrides: { open?: boolean; onAction?: (action: TerminalMenuAction) => void; onClose?: () => void } = {}) {
  const onAction = overrides.onAction ?? mock(() => {})
  const onClose = overrides.onClose ?? mock(() => {})
  render(<TerminalActionSheet open={overrides.open ?? true} onClose={onClose} onAction={onAction} />)
  return { onAction, onClose }
}

describe('TerminalActionSheet', () => {
  it('is the shared phone action sheet with four rows, none greyed out', () => {
    renderSheet()
    expect(document.querySelector('[data-action-sheet]')).toBeTruthy()
    expect(rows().map((row) => row.textContent)).toEqual(['Select Text', 'Paste', 'Find', 'Clear'])
    for (const row of rows()) expect(row).not.toBeDisabled()
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
