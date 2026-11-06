/**
 * The phone's Servers screen, the bottom level under Sessions: the saved
 * servers (the Server panel's list), a large "Servers" title, and on the row
 * in use a "Sessions ›" that goes back up to its session list. Other rows
 * keep Use, and Settings and the Server dialog never show Sessions ›.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const statusPayload = {
  base_url: 'http://127.0.0.1:5999',
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: false,
  servers: [
    { base_url: 'http://127.0.0.1:5999', name: 'Home Mac' },
    { base_url: 'http://127.0.0.1:4082', name: 'Work server' },
  ],
}

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'app_backend_status') return statusPayload
    if (command === 'app_server_watch_states') return {}
    throw new Error(`unexpected command: ${command}`)
  },
}))

const { ServersScreen } = await import('@/components/phone/ServersScreen')
const { AppBackendPanel } = await import('@/components/AppBackendPanel')

const originalFetch = globalThis.fetch

beforeEach(() => {
  window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:5999'
  globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

const rowOf = (name: string) => screen.getByText(name).closest('[data-server-row]') as HTMLElement

describe('ServersScreen', () => {
  it('lists the saved servers under a large Servers title', async () => {
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Servers' })).toBeTruthy()
    expect(await screen.findByText('Home Mac')).toBeTruthy()
    expect(screen.getByText('Work server')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Your servers' })).toBeTruthy()
  })

  it('opens the Sessions of the server in use; another server keeps Use', async () => {
    const onOpenSessions = mock(() => {})
    render(<ServersScreen active onOpenSessions={onOpenSessions} />)
    await screen.findByText('Home Mac')

    fireEvent.click(within(rowOf('Home Mac')).getByRole('button', { name: 'Open sessions on Home Mac' }))
    expect(onOpenSessions).toHaveBeenCalledTimes(1)

    const work = rowOf('Work server')
    expect(within(work).queryByRole('button', { name: /Open sessions/ })).toBeNull()
    expect(within(work).getByRole('button', { name: 'Use Work server' })).toBeTruthy()
  })

  it('has no Sessions › where the panel is not the Servers screen', async () => {
    render(<AppBackendPanel active />)
    await screen.findByText('Home Mac')
    expect(screen.queryByRole('button', { name: /Open sessions/ })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Servers' })).toBeTruthy()
  })
})
