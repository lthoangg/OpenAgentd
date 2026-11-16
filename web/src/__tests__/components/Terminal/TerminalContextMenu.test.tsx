import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TerminalContextMenu } from '@/components/Terminal/TerminalContextMenu'

afterEach(cleanup)

describe('TerminalContextMenu', () => {
  it('shows the terminal menu with keys, and runs a row after dismissing', () => {
    const onAction = mock(() => {})
    const onDismiss = mock(() => {})
    render(<TerminalContextMenu at={{ x: 10, y: 10 }} onDismiss={onDismiss} hasSelection os="macos" onAction={onAction} />)
    const items = screen.getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Copy⌘C', 'Paste⌘V', 'Select All', 'Find⌘F', 'Add to chat⌘L', 'Clear',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: /Clear/ }))
    expect(onDismiss).toHaveBeenCalled()
    expect(onAction).toHaveBeenCalledWith('clear')
  })

  it('disables Copy and Add to chat without a selection', () => {
    render(<TerminalContextMenu at={{ x: 10, y: 10 }} onDismiss={() => {}} hasSelection={false} os="linux" onAction={() => {}} />)
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /Add to chat/ })).toBeDisabled()
  })
})
