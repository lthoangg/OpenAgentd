import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TerminalMoreSheet } from '@/components/Terminal/TerminalMoreSheet'

afterEach(cleanup)

function renderSheet(overrides: Partial<{ altArmed: boolean; fontPx: number | null }> = {}) {
  const props = {
    onClose: mock(() => {}),
    onKey: mock(() => {}),
    onAltToggle: mock(() => {}),
    onResetFont: mock(() => {}),
  }
  render(<TerminalMoreSheet open {...props} altArmed={overrides.altArmed ?? false} fontPx={overrides.fontPx ?? null} />)
  return props
}

describe('TerminalMoreSheet', () => {
  it('holds only the keys a phone keyboard lacks or hides', () => {
    renderSheet()
    const keys = Array.from(screen.getByRole('group', { name: 'Keys' }).querySelectorAll('button'))
    expect(keys.map((key) => key.getAttribute('aria-label') ?? key.textContent)).toEqual([
      'Alt', 'Shift+Tab', 'Symbol |', 'Symbol ~', 'Symbol \\', 'Symbol `',
    ])
  })

  it('a key closes the sheet and is sent', () => {
    const props = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Shift+Tab' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onKey.mock.calls).toEqual([['\x1b[Z']])
    fireEvent.click(screen.getByRole('button', { name: 'Symbol |' }))
    expect(props.onKey.mock.calls[1]).toEqual(['|'])
  })

  it('Alt shows whether it is armed and toggles', () => {
    const props = renderSheet({ altArmed: true })
    const alt = screen.getByRole('button', { name: 'Alt' })
    expect(alt).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(alt)
    expect(props.onAltToggle).toHaveBeenCalledTimes(1)
  })

  it('shows the pinched size with Reset only once a pinch set one', () => {
    renderSheet()
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
    cleanup()
    const props = renderSheet({ fontPx: 16 })
    expect(screen.getByText('16 px')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(props.onResetFont).toHaveBeenCalledTimes(1)
  })
})
