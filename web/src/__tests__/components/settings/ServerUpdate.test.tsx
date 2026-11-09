/**
 * Settings → About → Version → Server: the update button and its note for
 * each state (available, updating, done, failed, cannot update here).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ServerUpdateStatus } from '@/api/client/server-update'

let data: ServerUpdateStatus | undefined
mock.module('@/queries/useServerUpdateQuery', () => ({
  useServerUpdateQuery: () => ({ data }),
  SERVER_UPDATE_CAPABILITY: 'api.server_update',
}))
const start = mock(async () => {})

const { ServerUpdateButton, ServerUpdateConfirm, ServerUpdateNote, blockedAdvice, useServerUpdateFlow } = await import('@/components/settings/ServerUpdate')
const { useServerUpdateStore } = await import('@/stores/useServerUpdateStore')
const { queryKeys } = await import('@/queries')

function available(overrides: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus {
  return {
    current: '3.50.0', latest: '3.51.0', available: true, can_upgrade: true, method: 'release', reason: null, check_error: null,
    in_progress: false, release_url: 'https://github.com/x/releases/tag/v3.51.0', log: '/s/logs/upgrade.log', last: null, ...overrides,
  }
}

let client: QueryClient
function Row() {
  const flow = useServerUpdateFlow()
  return (
    <>
      <ServerUpdateButton onRequest={flow.request} />
      <ServerUpdateNote />
      <ServerUpdateConfirm flow={flow} />
    </>
  )
}
const show = () => render(<QueryClientProvider client={client}><Row /></QueryClientProvider>)

beforeEach(() => {
  client = new QueryClient()
  data = available()
  start.mockClear()
  useServerUpdateStore.setState({ phase: { kind: 'idle' }, start })
})
afterEach(cleanup)

describe('ServerUpdate', () => {
  it('offers the update and says what it does', () => {
    show()
    expect(screen.getByRole('button', { name: 'Update to v3.51.0' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('restarts the server, and resumes running sessions')
    expect(screen.getByRole('button', { name: "What's new" })).toBeTruthy()
  })

  it('starts at once when no agent is working', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Update to v3.51.0' }))
    expect(start).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks first when agents are mid-turn', () => {
    client.setQueryData(queryKeys.session.sessions.active(), { pages: [{ data: [{ id: 's', running: true }], next_cursor: null, has_more: false }], pageParams: [null] })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Update to v3.51.0' }))
    expect(start).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toContain('Restart the server while agents work?')
    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('shows progress, then the result', () => {
    useServerUpdateStore.setState({ phase: { kind: 'updating', from: '3.50.0', target: '3.51.0' } })
    const { unmount } = show()
    expect((screen.getByRole('button', { name: /Updating/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('the app reconnects on its own')
    unmount()

    data = available({ current: '3.51.0', available: false })
    useServerUpdateStore.setState({ phase: { kind: 'done', from: '3.50.0', to: '3.51.0' } })
    show()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Updated v3.50.0 → v3.51.0.')
  })

  it('says what failed, where the log is, and offers another try', () => {
    useServerUpdateStore.setState({ phase: { kind: 'failed', message: 'checksum mismatch', log: '/s/logs/upgrade.log' } })
    show()
    expect(screen.getByRole('alert').textContent).toContain('checksum mismatch Details: /s/logs/upgrade.log on the server.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('tells a server that cannot update itself what to do instead', () => {
    data = available({ can_upgrade: false, reason: 'foreground' })
    show()
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('runs in the foreground, so update it where it runs: agentd upgrade')
    expect(blockedAdvice({ latest: '3.51.0', reason: 'desktop_sidecar' })).toBe('v3.51.0 is out. This server comes with the desktop app: update the app to update it.')
  })

  it('shows nothing when the server is up to date', () => {
    data = available({ available: false })
    const { container } = show()
    expect(container.textContent).toBe('')
  })
})
