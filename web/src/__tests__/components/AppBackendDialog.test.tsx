import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppBackendDialog } from '@/components/AppBackendDialog'

const originalFetch = globalThis.fetch
const invokeCalls: Array<{ command: string; args: unknown }> = []
let statusPayload = {
  base_url: 'http://127.0.0.1:5999',
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: true,
  servers: [
    { base_url: 'http://127.0.0.1:4082', name: 'Local CLI' },
    { base_url: 'http://127.0.0.1:4999', name: null },
  ],
}

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  const commandArgs = args[1]
  invokeCalls.push({ command, args: commandArgs })
  if (command === 'app_backend_status') return statusPayload
  if (command === 'app_save_backend_server') return statusPayload
  if (command === 'app_remove_backend_server') return statusPayload
  if (command === 'app_use_external_backend') {
    const args = commandArgs as { baseUrl?: string }
    return { ...statusPayload, base_url: args.baseUrl ?? statusPayload.base_url, mode: 'external', external: true, sidecar_running: false }
  }
  if (command === 'app_use_bundled_backend') return null
  throw new Error(`unexpected command: ${command}`)
})

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

beforeEach(() => {
  invokeCalls.length = 0
  statusPayload = {
    base_url: 'http://127.0.0.1:5999',
    mode: 'external',
    sidecar_running: false,
    external: true,
    supports_bundled: true,
    servers: [
      { base_url: 'http://127.0.0.1:4082', name: 'Local CLI' },
      { base_url: 'http://127.0.0.1:4999', name: null },
    ],
  }
  window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:5999'
  const fetchMock = mock((...args: unknown[]) => {
    const url = String(args[0])
    const ok = url.startsWith('http://127.0.0.1:4082/')
    const authorized = !url.endsWith('/api/auth/check') || ok
    return Promise.resolve(new Response(null, { status: ok && authorized ? 204 : 503 }))
  })
  globalThis.fetch = fetchMock as typeof fetch
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

describe('AppBackendDialog', () => {
  it('loads saved servers and shows live online/offline indicators', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Builtin sidecar')).toBeTruthy()
    expect(screen.getByText('Local CLI')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:4082')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:4999')).toBeTruthy()

    await waitFor(() => expect(screen.getByLabelText('Online')).toBeTruthy())
    await waitFor(() => expect(screen.getByLabelText('Offline')).toBeTruthy())
  })

  it('hides the bundled server row when the shell does not support bundled backends', async () => {
    statusPayload = { ...statusPayload, supports_bundled: false }

    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Local CLI')).toBeTruthy()
    expect(screen.queryByText('Builtin sidecar')).toBeNull()
  })

  it('blocks incomplete URLs before invoking a backend switch command', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'localhost')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText('Enter a full server URL, including http:// or https://.')).toBeTruthy()
    expect(invokeCalls.some((call) => call.command === 'app_set_backend_base_url')).toBe(false)
  })

  it('connects the builtin desktop server through the bundled backend command', async () => {
    const user = userEvent.setup()
    const onOpenChange = mock(() => {})
    statusPayload = {
      ...statusPayload,
      base_url: 'http://127.0.0.1:49545',
      mode: 'bundled',
      sidecar_running: true,
      external: false,
    }
    render(<AppBackendDialog open onOpenChange={onOpenChange} />)

    await screen.findByText('Builtin sidecar')
    await user.click(screen.getByRole('button', { name: 'use builtin' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_use_bundled_backend',
        args: undefined,
      })
    })
    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:49545'))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('lets users recover from an unreachable external backend by choosing builtin', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://192.168.1.20:4082',
      mode: 'external',
      sidecar_running: true,
      external: true,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('Builtin sidecar')
    await user.click(screen.getByRole('button', { name: 'use builtin' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_use_bundled_backend',
        args: undefined,
      })
    })
  })

  it('saves a server name without switching connections', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:5050')
    await user.type(screen.getByLabelText(/server name/i), 'Workstation')
    await user.click(screen.getByRole('button', { name: 'Save server' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_save_backend_server',
        args: { baseUrl: 'http://127.0.0.1:5050', name: 'Workstation' },
      })
    })
    expect(invokeCalls.some((call) => call.command === 'app_set_backend_base_url')).toBe(false)
  })

  it('removes a saved server', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const removeButtons = await screen.findAllByRole('button', { name: 'remove' })
    await user.click(removeButtons[0])

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_remove_backend_server',
        args: { baseUrl: 'http://127.0.0.1:4082' },
      })
    })
  })

  it('shows an error and does not switch when Check health probe fails', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4999')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText(/Server did not respond to \/api\/health\/live/)).toBeTruthy()
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:5999')
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)
  })

  it('checks and uses a valid typed URL without saving or closing', async () => {
    const user = userEvent.setup()
    const onOpenChange = mock(() => {})
    render(<AppBackendDialog open onOpenChange={onOpenChange} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4082')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: '', persist: true },
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('can switch to an external server without making it the remembered startup backend', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4082')
    await user.click(screen.getByLabelText(/save this server/i))
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: '', persist: false },
    })
  })

  it('checks and uses a LAN server URL', async () => {
    globalThis.fetch = mock((...args: unknown[]) => {
      const url = String(args[0])
      const ok = url.startsWith('http://192.168.1.20:4082/')
      return Promise.resolve(new Response(null, { status: ok ? 204 : 503 }))
    }) as typeof fetch
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://192.168.1.20:4082')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://192.168.1.20:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://192.168.1.20:4082', name: '', persist: true },
    })
  })

  it('selects a saved server without auto-connecting or reloading', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://wrong.example')
    await user.click(await screen.findByText('Local CLI'))

    await waitFor(() => expect((screen.getByLabelText(/server url/i) as HTMLInputElement).value).toBe('http://127.0.0.1:4082'))
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:5999')
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)
  })

  it('connects a saved server only from the explicit connect action', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server name/i), 'Stale typed name')
    const connectButtons = await screen.findAllByRole('button', { name: 'connect' })
    await user.click(connectButtons[0])

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Local CLI', persist: true },
    })
  })

  it('normalizes a typed /api URL before connecting', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4082/api')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: '', persist: true },
    })
  })

  it('stores the typed access key before invoking a connect command', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/access key/i), 'secret')
    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4082')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(window.localStorage.getItem('openagentd.accessKey')).toBe('secret')
  })

  it('shows a local-specific failure message for localhost URLs', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4999')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText(/Make sure OpenAgentd is running locally and the port is correct/)).toBeTruthy()
  })
})
