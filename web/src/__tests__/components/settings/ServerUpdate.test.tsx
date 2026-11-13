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

const { ServerUpdateButton, ServerUpdateConfirm, ServerUpdateNote, ServerUpdateOnRow, blockedAdvice, useServerUpdateFlow } = await import('@/components/settings/ServerUpdate')
const { useServerUpdateStore } = await import('@/stores/useServerUpdateStore')
const { queryKeys } = await import('@/queries')
const { queryClient: appClient } = await import('@/lib/query-client')

function available(overrides: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus {
  return {
    current: '3.50.0', latest: '3.51.0', available: true, can_upgrade: true, method: 'release', reason: null, check_error: null,
    in_progress: false, release_url: 'https://github.com/x/releases/tag/v3.51.0', log: '/s/logs/upgrade.log', last: null, ...overrides,
  }
}

let client: QueryClient
function Row({ ownApp = false }: { ownApp?: boolean }) {
  const flow = useServerUpdateFlow()
  return (
    <>
      <ServerUpdateButton onRequest={flow.request} ownApp={ownApp} />
      <ServerUpdateNote ownApp={ownApp} />
      <ServerUpdateConfirm flow={flow} />
    </>
  )
}
const show = (ownApp = false) => render(<QueryClientProvider client={client}><Row ownApp={ownApp} /></QueryClientProvider>)
// Bare, as the Servers screen and the Server dialog show before the router's
// provider exists; the app's own client says what it knows of the server.
const showOnRow = () => render(<ServerUpdateOnRow />)

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
    expect(blockedAdvice({ latest: '3.51.0', reason: 'desktop_sidecar' })).toBe('v3.51.0 is out. This server is the desktop app on its computer: update the app there.')
  })

  it('shows nothing when the server is up to date', () => {
    data = available({ available: false })
    const { container } = show()
    expect(container.textContent).toBe('')
  })
})

describe('ServerUpdate for a desktop app’s server', () => {
  it('offers the update and says it happens on that computer', () => {
    data = available({ method: 'desktop_app' })
    show()
    expect(screen.getByRole('button', { name: 'Update to v3.51.0' })).toBeTruthy()
    const note = screen.getByRole('status').textContent
    expect(note).toContain('Updates OpenAgentd on that computer and restarts it. Running sessions resume.')
    expect(note).not.toContain('Windows')
  })

  it('says so when Windows may wait for someone at the computer', () => {
    data = available({ method: 'desktop_app', confirm_on_computer: true })
    const { unmount } = show()
    expect(screen.getByRole('status').textContent).toContain('Windows may ask to confirm it on the computer.')
    unmount()

    useServerUpdateStore.setState({ phase: { kind: 'updating', from: '3.50.0', target: '3.51.0' } })
    show()
    const note = screen.getByRole('status').textContent
    expect(note).toContain('OpenAgentd on the computer downloads it and restarts')
    expect(note).toContain('If Windows asks, confirm the update on the computer.')
  })

  it('leaves an app that cannot update itself (Linux) as update on the computer', () => {
    data = available({ can_upgrade: false, reason: 'desktop_sidecar', method: null })
    show()
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('v3.51.0 is out. This server is the desktop app on its computer: update the app there.')
  })

  it('in the desktop app on its own server, leaves the update to the app’s Updates section', () => {
    data = available({ method: 'desktop_app' })
    show(true)
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('v3.51.0 is out. This server comes with this app: update the app to update it.')
  })
})

describe('ServerUpdateOnRow', () => {
  beforeEach(() => {
    appClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.50.0', capabilities: ['api.server_update'] })
  })
  afterEach(() => appClient.clear())

  it('puts the same button and note under the row of the server in use', () => {
    data = available({ method: 'desktop_app' })
    showOnRow()
    fireEvent.click(screen.getByRole('button', { name: 'Update to v3.51.0' }))
    expect(start).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Updates OpenAgentd on that computer')
  })

  it('keeps showing the run it started', () => {
    data = available({ current: '3.51.0', available: false })
    useServerUpdateStore.setState({ phase: { kind: 'done', from: '3.50.0', to: '3.51.0' } })
    showOnRow()
    expect(screen.getByRole('status').textContent).toBe('Updated v3.50.0 → v3.51.0.')
  })

  it('adds nothing for a server the app knows nothing about yet', () => {
    appClient.clear()
    data = available({ method: 'desktop_app' })
    expect(showOnRow().container.innerHTML).toBe('')
  })

  it('adds nothing to the row when there is nothing to press', () => {
    data = available({ available: false })
    expect(showOnRow().container.innerHTML).toBe('')
    cleanup()
    data = available({ can_upgrade: false, reason: 'foreground' })
    expect(showOnRow().container.innerHTML).toBe('')
  })
})
