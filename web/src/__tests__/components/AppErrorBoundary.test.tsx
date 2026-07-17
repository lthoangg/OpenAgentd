/**
 * Tests for ``AppErrorBoundary`` — the root render-crash guard.
 *
 * Covers:
 *  - Children render untouched when nothing throws
 *  - A throwing child is caught: fallback with role="alert" appears
 *  - Reload button triggers the injected reload callback
 *  - Copy Error Details writes message + stack to the clipboard and
 *    flips its label to confirm
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'

afterEach(cleanup)

function Bomb(): never {
  throw new Error('kaboom: render failed')
}

describe('AppErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <AppErrorBoundary>
        <p>all good</p>
      </AppErrorBoundary>,
    )
    expect(screen.getByText('all good')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('catches a render crash and shows the fallback', () => {
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy error details/i })).toBeInTheDocument()
    // The raw error message is surfaced so users can report it.
    expect(screen.getByText(/kaboom: render failed/)).toBeInTheDocument()
  })

  it('reload button invokes the reload callback', () => {
    const reload = mock(() => {})
    render(
      <AppErrorBoundary reload={reload}>
        <Bomb />
      </AppErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /reload/i }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('copy error details writes to the clipboard and confirms', async () => {
    const writeText = mock(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /copy error details/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(copied).toContain('kaboom: render failed')
  })
})
