import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { OverlayHeader } from '@/components/ui/app-overlay'

afterEach(cleanup)

describe('OverlayHeader', () => {
  test('renders the title as the panel heading with an optional subtitle', () => {
    render(<OverlayHeader title="Session settings" subtitle="Applies from your next message." />)
    expect(screen.getByRole('heading', { level: 2, name: 'Session settings' })).toBeTruthy()
    expect(screen.getByText('Applies from your next message.')).toBeTruthy()
  })

  test('renders a named close button only when onClose is set', () => {
    const { rerender } = render(<OverlayHeader title="Shortcuts" />)
    expect(screen.queryByRole('button')).toBeNull()

    const onClose = mock(() => {})
    rerender(<OverlayHeader title="Shortcuts" onClose={onClose} closeLabel="Close shortcuts" />)
    const close = screen.getByRole('button', { name: 'Close shortcuts' })
    expect(close.getAttribute('data-slot')).toBe('button')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('places leading controls before the title and actions before close', () => {
    render(
      <OverlayHeader
        title="Tasks"
        leading={<button type="button">Back</button>}
        actions={<button type="button">New</button>}
        onClose={() => {}}
        closeLabel="Close"
      />,
    )
    const names = screen.getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))
    expect(names).toEqual(['Back', 'New', 'Close'])
  })
})
