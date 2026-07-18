import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppBackendDialog } from '@/components/AppBackendDialog'

const originalFetch = globalThis.fetch
const originalReload = window.location.reload
const invokeCalls: Array<{ command: string; args: unknown }> = []
const reloadMock = mock(() => {})
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
  if (command === 'app_use_bundled_backend') {
    statusPayload = {
      ...statusPayload,
      base_url: 'http://127.0.0.1:49545',
      mode: 'bundled',
      sidecar_running: true,
      external: false,
    }
    return null
  }
  if (command === 'app_stop_bundled_backend') {
    statusPayload = {
      ...statusPayload,
      sidecar_running: false,
    }
    return null
  }
  throw new Error(`unexpected command: ${command}`)
})

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

beforeEach(() => {
  invokeCalls.length = 0
  reloadMock.mockClear()
  window.location.reload = reloadMock as typeof window.location.reload
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
  window.location.reload = originalReload
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
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Enter a full server URL, including http:// or https://.')).toBeTruthy()
    expect(invokeCalls.some((call) => call.command === 'app_set_backend_base_url')).toBe(false)
  })

  it('shows stop instead of use builtin while already connected to bundled backend', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://127.0.0.1:49545',
      mode: 'bundled',
      sidecar_running: true,
      external: false,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('Builtin sidecar')
    expect(screen.queryByRole('button', { name: 'use builtin' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'stop' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_stop_bundled_backend',
        args: undefined,
      })
    })
  })

  it('shows stop when builtin sidecar is already running even if an external server is active', async () => {
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
    expect(screen.queryByRole('button', { name: 'use builtin' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'stop' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_stop_bundled_backend',
        args: undefined,
      })
    })
  })

  it('offers a connect option to switch back to a running builtin sidecar that is not the active backend', async () => {
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
    // The builtin sidecar row renders first in the connection options list,
    // so its "connect" button is the first match.
    const [connectButton] = await screen.findAllByRole('button', { name: 'connect' })
    await user.click(connectButton)

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_use_bundled_backend',
        args: undefined,
      })
    })
    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:49545'))
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('lets users recover from an unreachable external backend by choosing builtin when the sidecar is stopped', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://192.168.1.20:4082',
      mode: 'external',
      sidecar_running: false,
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
    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:49545'))
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('requires a successful test before saving and connecting a server', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    // This test verifies the test-before-save state machine, not per-key
    // semantics. Paste each value in one input event so the parallel suite
    // does not spend its 5 s test budget dispatching every character.
    await user.click(screen.getByLabelText(/server url/i))
    await user.paste('http://127.0.0.1:4082')
    await user.click(screen.getByLabelText(/access key/i))
    await user.paste('secret')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(screen.getByText('Connection successful.')).toBeTruthy())
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)

    await user.click(screen.getByLabelText(/server name/i))
    await user.paste('Workstation')
    await user.click(screen.getByRole('button', { name: 'Save & Connect' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Workstation', persist: true },
    })
    expect(window.localStorage.getItem('openagentd.accessKey:http://127.0.0.1:4082')).toBe('secret')
  })

  it('populates a saved server for editing and overwrites it when saved', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const editButtons = await screen.findAllByRole('button', { name: 'edit' })
    await user.click(editButtons[0])
    expect((screen.getByLabelText(/server url/i) as HTMLInputElement).value).toBe('http://127.0.0.1:4082')
    expect((screen.getByLabelText(/server name/i) as HTMLInputElement).value).toBe('Local CLI')

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await user.clear(screen.getByLabelText(/server name/i))
    await user.type(screen.getByLabelText(/server name/i), 'Renamed CLI')
    await user.click(screen.getByRole('button', { name: 'Save & Connect' }))

    await waitFor(() => expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Renamed CLI', persist: true },
    }))
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
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText(/Server did not respond to \/api\/health\/live/)).toBeTruthy()
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:5999')
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)
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

  it('stores the typed access key after a successful connection test', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/access key/i), 'secret')
    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4082')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(screen.getByText('Connection successful.')).toBeTruthy())
    expect(window.localStorage.getItem('openagentd.accessKey:http://127.0.0.1:4082')).toBe('secret')
    expect(window.localStorage.getItem('openagentd.accessKey')).toBeNull()
  })

  it('shows a local-specific failure message for localhost URLs', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4999')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText(/Make sure OpenAgentd is running locally and the port is correct/)).toBeTruthy()
  })

  it('calls onOpenChange(false) when the backdrop is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChangeMock = mock(() => {})
    render(<AppBackendDialog open onOpenChange={onOpenChangeMock} />)

    // The backdrop is the aria-hidden overlay behind the dialog panel
    const backdrop = document.querySelector('[aria-hidden="true"].fixed.inset-0') as HTMLElement
    expect(backdrop).toBeTruthy()
    await user.click(backdrop)

    expect(onOpenChangeMock).toHaveBeenCalledWith(false)
  })

  it('does NOT call onOpenChange when clicking inside the dialog', async () => {
    const user = userEvent.setup()
    const onOpenChangeMock = mock(() => {})
    render(<AppBackendDialog open onOpenChange={onOpenChangeMock} />)

    // Click inside the dialog (e.g. the title)
    const title = screen.getByText('Backend connection')
    await user.click(title)

    expect(onOpenChangeMock).not.toHaveBeenCalled()
  })
})
