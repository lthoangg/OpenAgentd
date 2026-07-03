/**
 * TerminalPanel — cockpit terminal host (normal mode).
 *
 * Wraps store-backed terminal sessions keyed `session:{chatSessionId}` in
 * a right-side panel with a tab strip. The PTY cwd is the per-session
 * workspace, derived server-side from the session id.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'

const SID = 'sid-123'
const CONTEXT = `session:${SID}`

const Icon = () => null
mock.module('lucide-react', () => ({
  Pencil: Icon, Plus: Icon, TerminalSquare: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
    div: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}))
let connectCalls: unknown[] = []
mock.module('@/api/terminal', () => ({
  connectTerminal: mock((target: unknown) => {
    connectCalls.push(target)
    return new Promise(() => {})
  }),
}))

beforeEach(() => {
  _resetTerminalStoreForTests()
  connectCalls = []
})
afterEach(cleanup)

async function renderPanel(props: { open?: boolean; openKey?: number } = {}) {
  const { TerminalPanel } = await import('@/components/Terminal/TerminalPanel')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <TerminalPanel
        open={props.open ?? true}
        sessionId={SID}
        openKey={props.openKey ?? 0}
        onClose={() => {}}
      />,
    )
  })
  return result!
}

describe('TerminalPanel (cockpit)', () => {
  it('openKey bump opens a session-targeted terminal', async () => {
    await renderPanel({ openKey: 1 })
    await waitFor(() =>
      expect(useTerminalStore.getState().sessionsForContext(CONTEXT)).toHaveLength(1),
    )
    // Ticket must be minted from the session id, not a client path.
    expect(connectCalls[0]).toEqual({ sessionId: SID })
    expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy()
  })

  it('"New terminal" opens additional sessions', async () => {
    await renderPanel({ openKey: 1 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('button', { name: 'New terminal' }).click()
    })
    expect(useTerminalStore.getState().sessionsForContext(CONTEXT)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Close Terminal 2' })).toBeTruthy()
  })

  it('closing a tab closes the session; closing the panel does not', async () => {
    const view = await renderPanel({ openKey: 1 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())

    // Unmount (panel closed) — session survives in the store.
    view.unmount()
    expect(useTerminalStore.getState().sessionsForContext(CONTEXT)).toHaveLength(1)

    // Remount — tab re-adopted; explicit close removes the session.
    await renderPanel({ openKey: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('button', { name: 'Close Terminal 1' }).click()
    })
    expect(useTerminalStore.getState().sessionsForContext(CONTEXT)).toHaveLength(0)
  })
})
