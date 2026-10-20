/**
 * The sidebar's compact age must keep up with the clock: it used to be
 * computed once at render and froze until something else re-rendered the row.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useCompactRelative } from '@/hooks/useCompactRelative'

function Age({ at }: { at: string }) {
  return <span data-testid="age">{useCompactRelative(at)}</span>
}

const realNow = Date.now
// The hook's clock reads Date.now; pin it.
function setNow(iso: string) {
  const at = Date.parse(iso)
  Date.now = () => at
}

afterEach(() => {
  cleanup()
  Date.now = realNow
})

describe('useCompactRelative', () => {
  it('advances on its own clock, here when the tab becomes visible again', () => {
    setNow('2026-10-20T08:00:30Z')
    render(<Age at="2026-10-20T08:00:00Z" />)
    expect(screen.getByTestId('age')).toHaveTextContent('now')

    setNow('2026-10-20T08:05:10Z')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(screen.getByTestId('age')).toHaveTextContent('5m')
  })

  it('follows a new timestamp at once', () => {
    setNow('2026-10-20T08:00:00Z')
    const { rerender } = render(<Age at="2026-10-20T05:00:00Z" />)
    expect(screen.getByTestId('age')).toHaveTextContent('3h')

    rerender(<Age at="2026-10-20T08:00:00Z" />)

    expect(screen.getByTestId('age')).toHaveTextContent('now')
  })
})
