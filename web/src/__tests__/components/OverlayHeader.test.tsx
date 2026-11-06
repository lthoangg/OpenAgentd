import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// A phone (the sheet's iOS bar) and its OS, set per test.
let phone = false
let os = 'ios'
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => phone }))
mock.module('@/hooks/use-platform', () => ({ usePlatform: () => ({ os }), getPlatform: () => ({ os }) }))

const { OverlayHeader } = await import('@/components/ui/app-overlay')

afterEach(() => {
  cleanup()
  phone = false
  os = 'ios'
})

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

  test('goes back with a named ← and a tooltip where the overlay has room', () => {
    const onBack = mock(() => {})
    render(<OverlayHeader title="Turn" back={{ label: 'Usage', onBack }} />)
    const back = screen.getByRole('button', { name: 'Back to Usage' })
    expect(back.textContent).toBe('')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  describe('on a phone', () => {
    test('is the sheet\'s bar: ‹ and the parent\'s name, the title centred, Done', () => {
      phone = true
      const onBack = mock(() => {})
      const onClose = mock(() => {})
      const { container } = render(<OverlayHeader title="Providers" back={{ label: 'Settings', onBack }} onClose={onClose} closeLabel="Close settings" />)

      const back = screen.getByRole('button', { name: 'Back to Settings' })
      expect(back.textContent).toBe('Settings')
      expect(screen.getByRole('heading', { name: 'Providers' }).parentElement?.className).toContain('text-center')
      expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(onClose).toHaveBeenCalledTimes(1)
      fireEvent.click(back)
      expect(onBack).toHaveBeenCalledTimes(1)
      expect(container.querySelector('[data-sheet-bar]')).not.toBeNull()
    })

    test('puts the title beside a bare ← on Android', () => {
      phone = true
      os = 'android'
      render(<OverlayHeader title="Providers" back={{ label: 'Settings', onBack: () => {} }} onClose={() => {}} />)
      expect(screen.getByRole('button', { name: 'Back to Settings' }).textContent).toBe('')
      expect(screen.getByRole('heading', { name: 'Providers' }).parentElement?.className).toContain('flex-1')
    })
  })
})
