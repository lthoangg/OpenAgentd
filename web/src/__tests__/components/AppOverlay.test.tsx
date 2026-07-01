/**
 * AppOverlay — unified overlay primitive tests
 *
 * Critical paths:
 *  - Nothing rendered when open=false
 *  - Backdrop + panel both rendered when open=true
 *  - role="dialog", aria-modal="true", aria-label forwarded correctly
 *  - data-overlay-variant reflects the variant prop
 *  - modal variant: --overlay-max-width CSS var set from maxWidth prop
 *  - palette variant: no --overlay-max-width var; gets app-overlay-palette class
 *  - Backdrop click calls onClose
 *  - Clicking inside the panel does NOT call onClose
 *  - Escape key calls onClose (via useModalFocus)
 *  - No sheet variant exists (regression guard)
 *  - className forwarded to panel element
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppOverlay } from '@/components/ui/app-overlay'

afterEach(cleanup)

function renderOverlay(props: Partial<Parameters<typeof AppOverlay>[0]> = {}) {
  return render(
    <AppOverlay open onClose={() => {}} label="Test overlay" {...props}>
      <div>panel content</div>
    </AppOverlay>,
  )
}

// ── Visibility ────────────────────────────────────────────────────────────────

describe('AppOverlay — visibility', () => {
  it('renders nothing when open=false', () => {
    render(
      <AppOverlay open={false} onClose={() => {}} label="hidden">
        <div>should not appear</div>
      </AppOverlay>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('should not appear')).toBeNull()
  })

  it('renders dialog and children when open=true', () => {
    renderOverlay()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('panel content')).toBeTruthy()
  })

  it('renders a backdrop element alongside the panel', () => {
    const { container } = renderOverlay()
    const backdrop = container.querySelector('[aria-hidden="true"].fixed')
    expect(backdrop).toBeTruthy()
  })
})

// ── Accessibility attrs ───────────────────────────────────────────────────────

describe('AppOverlay — accessibility', () => {
  it('sets aria-modal="true" on the panel', () => {
    renderOverlay()
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('forwards the label prop as aria-label', () => {
    renderOverlay({ label: 'My settings panel' })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('My settings panel')
  })

  it('sets data-modal-focus on the panel', () => {
    renderOverlay()
    expect(screen.getByRole('dialog').getAttribute('data-modal-focus')).toBe('true')
  })
})

// ── Variants ──────────────────────────────────────────────────────────────────

describe('AppOverlay — variants', () => {
  it('defaults to modal variant', () => {
    renderOverlay()
    expect(screen.getByRole('dialog').getAttribute('data-overlay-variant')).toBe('modal')
  })

  it('sets data-overlay-variant="palette" for palette variant', () => {
    renderOverlay({ variant: 'palette' })
    expect(screen.getByRole('dialog').getAttribute('data-overlay-variant')).toBe('palette')
  })

  it('modal variant gets app-overlay-modal class', () => {
    renderOverlay({ variant: 'modal' })
    expect(screen.getByRole('dialog').className).toContain('app-overlay-modal')
  })

  it('palette variant gets app-overlay-palette class', () => {
    renderOverlay({ variant: 'palette' })
    expect(screen.getByRole('dialog').className).toContain('app-overlay-palette')
  })

  it('modal variant does not get palette class', () => {
    renderOverlay({ variant: 'modal' })
    expect(screen.getByRole('dialog').className).not.toContain('app-overlay-palette')
  })

  it('no sheet variant — app-overlay-sheet class never appears', () => {
    renderOverlay({ variant: 'modal' })
    expect(screen.getByRole('dialog').className).not.toContain('app-overlay-sheet')
    renderOverlay({ variant: 'palette' })
    expect(screen.getAllByRole('dialog').at(-1)!.className).not.toContain('app-overlay-sheet')
  })
})

// ── maxWidth CSS variable ──────────────────────────────────────────────────────

describe('AppOverlay — maxWidth CSS variable', () => {
  it('sets --overlay-max-width from the maxWidth prop on modal variant', () => {
    renderOverlay({ variant: 'modal', maxWidth: '1100px' })
    const panel = screen.getByRole('dialog') as HTMLElement
    expect(panel.style.getPropertyValue('--overlay-max-width')).toBe('1100px')
  })

  it('uses 860px default when no maxWidth given', () => {
    renderOverlay({ variant: 'modal' })
    const panel = screen.getByRole('dialog') as HTMLElement
    expect(panel.style.getPropertyValue('--overlay-max-width')).toBe('860px')
  })

  it('does NOT set --overlay-max-width on palette variant', () => {
    renderOverlay({ variant: 'palette', maxWidth: '480px' })
    const panel = screen.getByRole('dialog') as HTMLElement
    expect(panel.style.getPropertyValue('--overlay-max-width')).toBe('')
  })
})

// ── className forwarding ──────────────────────────────────────────────────────

describe('AppOverlay — className', () => {
  it('forwards extra className to the panel element', () => {
    renderOverlay({ className: 'my-custom-class' })
    expect(screen.getByRole('dialog').className).toContain('my-custom-class')
  })
})

// ── Interactions ──────────────────────────────────────────────────────────────

describe('AppOverlay — interactions', () => {
  it('calls onClose when the backdrop is clicked', async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    const { container } = render(
      <AppOverlay open onClose={onClose} label="dialog">
        <div>content</div>
      </AppOverlay>,
    )
    const backdrop = container.querySelector('[aria-hidden="true"].fixed') as HTMLElement
    expect(backdrop).toBeTruthy()
    await user.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onClose when clicking inside the panel', async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(
      <AppOverlay open onClose={onClose} label="dialog">
        <button type="button">inside button</button>
      </AppOverlay>,
    )
    await user.click(screen.getByText('inside button'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(
      <AppOverlay open onClose={onClose} label="dialog">
        <div>content</div>
      </AppOverlay>,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onClose on Escape when open=false', async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(
      <AppOverlay open={false} onClose={onClose} label="dialog">
        <div>content</div>
      </AppOverlay>,
    )
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
