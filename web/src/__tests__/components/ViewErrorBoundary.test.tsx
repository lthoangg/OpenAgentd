/**
 * A crash in the chat column or the Review panel shows a recovery panel in
 * their place; the sidebar beside it keeps working, Try again renders the
 * view afresh, and another session clears it. The router's error page covers
 * a crash anywhere else in a route, in the app's own words and buttons.
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ViewErrorBoundary } from '@/components/ViewErrorBoundary'
import { RouteErrorPage } from '@/components/RouteErrorPage'

afterEach(cleanup)

let crash = true
function Transcript() {
  if (crash) throw new Error('Cannot read properties of undefined (reading "blocks")')
  return <p>transcript</p>
}

function Shell({ session }: { session: string }) {
  return (
    <>
      <nav>sidebar</nav>
      <ViewErrorBoundary resetKey={session}><Transcript /></ViewErrorBoundary>
    </>
  )
}

describe('ViewErrorBoundary', () => {
  it('shows the error in place of the view and keeps the sidebar', () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    crash = true
    render(<Shell session="s1" />)

    expect(screen.getByRole('alert').textContent).toContain("Couldn't show this view")
    expect(screen.getByText('Cannot read properties of undefined (reading "blocks")')).toBeTruthy()
    expect(screen.getByText('sidebar')).toBeTruthy()
    quiet.mockRestore()
  })

  it('renders the view afresh on Try again', () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    crash = true
    render(<Shell session="s1" />)
    crash = false

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('transcript')).toBeTruthy()
    quiet.mockRestore()
  })

  it('clears when another session opens', () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    crash = true
    const { rerender } = render(<Shell session="s1" />)
    crash = false

    rerender(<Shell session="s2" />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('transcript')).toBeTruthy()
    quiet.mockRestore()
  })

  it('wraps the chat column and the Review panel, reset by the session', () => {
    const view = readFileSync(fileURLToPath(new URL('../../components/AgentChatView/index.tsx', import.meta.url)), 'utf8')
    expect(view).toMatch(/<ViewErrorBoundary resetKey=\{sessionIdState\}>/)
  })
})

describe('RouteErrorPage', () => {
  it('names the error and tries the route again', () => {
    const reset = mock(() => {})
    render(<RouteErrorPage error={new Error('boom')} reset={reset} />)

    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
    expect(screen.getByText('boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('is the router’s page for an error in any route', async () => {
    const { router } = await import('@/router')
    expect(router.options.defaultErrorComponent).toBe(RouteErrorPage)
  })
})
