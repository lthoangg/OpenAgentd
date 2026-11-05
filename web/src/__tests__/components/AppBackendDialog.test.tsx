import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppBackendDialog } from '@/components/AppBackendDialog'
import { ConnectionSettingsPage } from '@/components/settings/pages/settings.connection'

const originalFetch = globalThis.fetch
const originalWindowFetch = window.fetch
const originalReload = window.location.reload
const invokeCalls: Array<{ command: string; args: unknown }> = []
const reloadMock = mock(() => {})
let failExternalSwitch = false
let watchStates: Record<string, string> = {}
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []
let statusPayload = {
  base_url: 'http://127.0.0.1:5999',
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: true,
  servers: [
    { base_url: 'http://127.0.0.1:4082', name: 'Local CLI' },
    { base_url: 'http://127.0.0.1:4999', name: null },
  ] as Array<{ base_url: string; name: string | null; enabled?: boolean }>,
}

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  const commandArgs = args[1]
  invokeCalls.push({ command, args: commandArgs })
  if (command === 'app_backend_status') return statusPayload
  if (command === 'app_save_backend_server') return statusPayload
  if (command === 'app_remove_backend_server') return statusPayload
  if (command === 'app_server_watch_states') return watchStates
  if (command === 'app_set_backend_server_enabled') {
    const args = commandArgs as { baseUrl: string; enabled: boolean }
    statusPayload = {
      ...statusPayload,
      servers: statusPayload.servers.map((server) => (
        server.base_url === args.baseUrl ? { ...server, enabled: args.enabled } : server
      )),
    }
    return statusPayload
  }
  if (command === 'app_use_external_backend') {
    if (failExternalSwitch) throw new Error('switch failed')
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
  fetchCalls = []
  failExternalSwitch = false
  watchStates = {}
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
    ] as Array<{ base_url: string; name: string | null; enabled?: boolean }>,
  }
  window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:5999'
  const fetchMock = mock((...args: unknown[]) => {
    const url = String(args[0])
    fetchCalls.push({ url, init: args[1] as RequestInit | undefined })
    const ok = url.startsWith('http://127.0.0.1:4082/')
    const authorized = !url.endsWith('/api/auth/check') || ok
    return Promise.resolve(new Response(null, { status: ok && authorized ? 204 : 503 }))
  })
  globalThis.fetch = fetchMock as typeof fetch
  window.fetch = fetchMock as typeof window.fetch
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete window.__OAD_TOKEN__
  globalThis.fetch = originalFetch
  window.fetch = originalWindowFetch
  window.location.reload = originalReload
  delete window.__OAD_API_BASE_URL__
})

/** "Add a server" is a button: the form opens only when asked. */
async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add a server' }))
}

describe('AppBackendDialog', () => {
  it('installs browser auth for a keyed backend after switching to it', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText(/access key/i), 'secret')
    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4082')
    await user.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByText('Connection successful.')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Save and use' }))
    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))

    await fetch('http://127.0.0.1:4082/api/health/live')
    const request = fetchCalls.at(-1)
    expect(new Headers(request?.init?.headers).get('Authorization')).toBe('Bearer secret')
  })

  it('keeps the bundled auth token when switching to an external backend fails', async () => {
    const user = userEvent.setup()
    window.__OAD_TOKEN__ = 'bundled-token'
    failExternalSwitch = true
    statusPayload = {
      ...statusPayload,
      base_url: 'http://127.0.0.1:49545',
      mode: 'bundled',
      sidecar_running: true,
      external: false,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('Built-in server')
    await user.click(await screen.findByRole('button', { name: 'Use Local CLI' }))

    await screen.findByText('switch failed')
    expect(window.__OAD_TOKEN__).toBe('bundled-token')
  })

  it('loads saved servers and shows live online/offline indicators', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Built-in server')).toBeTruthy()
    expect(screen.getByText('Local CLI')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:4082')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:4999')).toBeTruthy()

    const rowOf = (text: string) => screen.getByText(text).closest('[data-server-row]') as HTMLElement
    await waitFor(() => expect(within(rowOf('Local CLI')).getByLabelText('Online')).toBeTruthy())
    await waitFor(() => expect(within(rowOf('http://127.0.0.1:4999')).getByLabelText('Offline')).toBeTruthy())
  })

  it('hides the bundled server row when the shell does not support bundled backends', async () => {
    statusPayload = { ...statusPayload, supports_bundled: false }

    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Local CLI')).toBeTruthy()
    expect(screen.queryByText('Built-in server')).toBeNull()
  })

  it('blocks incomplete URLs before invoking a backend switch command', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText(/server url/i), 'localhost')
    await user.click(screen.getByRole('button', { name: 'Test' }))

    expect(await screen.findByText('Enter a full server URL, including http:// or https://.')).toBeTruthy()
    expect(invokeCalls.some((call) => call.command === 'app_set_backend_base_url')).toBe(false)
  })

  it('shows Stop instead of Use builtin while already connected to bundled backend', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://127.0.0.1:49545',
      mode: 'bundled',
      sidecar_running: true,
      external: false,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('Built-in server')
    expect(screen.queryByRole('button', { name: 'Start and use' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Stop…' }))
    await user.click(await screen.findByRole('button', { name: 'Stop server' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_stop_bundled_backend',
        args: undefined,
      })
    })
  })

  it('shows Stop when builtin sidecar is already running even if an external server is active', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://192.168.1.20:4082',
      mode: 'external',
      sidecar_running: true,
      external: true,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('Built-in server')
    expect(screen.queryByRole('button', { name: 'Start and use' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Stop…' }))
    await user.click(await screen.findByRole('button', { name: 'Stop server' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_stop_bundled_backend',
        args: undefined,
      })
    })
  })

  it('offers a Connect option to switch back to a running builtin sidecar that is not the active backend', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://192.168.1.20:4082',
      mode: 'external',
      sidecar_running: true,
      external: true,
    }
    // A session id from the old server must not be reopened on the new one.
    window.history.replaceState(null, '', '/old-session')
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('Built-in server')
    await user.click(await screen.findByRole('button', { name: 'Use built-in server' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_use_bundled_backend',
        args: undefined,
      })
    })
    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:49545'))
    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(window.location.pathname).toBe('/')
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

    await screen.findByText('Built-in server')
    await user.click(screen.getByRole('button', { name: 'Start and use' }))

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
    await openAddForm(user)

    // This test verifies the test-before-save state machine, not per-key
    // semantics. Paste each value in one input event so the parallel suite
    // does not spend its 5 s test budget dispatching every character.
    await user.click(screen.getByLabelText(/server url/i))
    await user.paste('http://127.0.0.1:4082')
    await user.click(screen.getByLabelText(/access key/i))
    await user.paste('secret')
    await user.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => expect(screen.getByText('Connection successful.')).toBeTruthy())
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)

    await user.click(screen.getByLabelText(/server name/i))
    await user.paste('Workstation')
    await user.click(screen.getByRole('button', { name: 'Save and use' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Workstation', persist: true },
    })
    expect(window.localStorage.getItem('openagentd.accessKey:http://127.0.0.1:4082')).toBe('secret')
  })

  it('renames a saved server in place from its Edit, without switching to it', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.click(await screen.findByRole('button', { name: 'Edit Local CLI' }))
    const form = screen.getByRole('group', { name: 'Edit Local CLI' })
    expect((within(form).getByLabelText(/server url/i) as HTMLInputElement).value).toBe('http://127.0.0.1:4082')
    expect((within(form).getByLabelText(/server name/i) as HTMLInputElement).value).toBe('Local CLI')

    // A new name needs no Test.
    await user.clear(within(form).getByLabelText(/server name/i))
    await user.type(within(form).getByLabelText(/server name/i), 'Renamed CLI')
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls).toContainEqual({
      command: 'app_save_backend_server',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Renamed CLI' },
    }))
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit Local CLI' })).toBeNull())
  })

  it('opens the edit form right under its row, apart from the add form', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const edit = await screen.findByRole('button', { name: 'Edit Local CLI' })
    await user.click(edit)
    const row = edit.closest('[data-server-row]') as HTMLElement
    const form = screen.getByRole('group', { name: 'Edit Local CLI' })
    expect(row.nextElementSibling).toBe(form)
    expect(edit.getAttribute('aria-expanded')).toBe('true')
    // The add form is a different place: opening it closes the edit form.
    await openAddForm(user)
    expect(screen.queryByRole('group', { name: 'Edit Local CLI' })).toBeNull()
    const add = screen.getByRole('group', { name: 'Add a server' })
    expect(add.nextElementSibling).toBeNull()
  })

  it('asks for a Test before saving a new address, then replaces the old entry', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.click(await screen.findByRole('button', { name: 'Edit http://127.0.0.1:4999' }))
    const form = screen.getByRole('group', { name: 'Edit http://127.0.0.1:4999' })
    const url = within(form).getByLabelText(/server url/i)
    await user.clear(url)
    await user.click(url)
    await user.paste('http://127.0.0.1:4082')
    expect((within(form).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)

    await user.click(within(form).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(within(form).getByText('Connection successful.')).toBeTruthy())
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls).toContainEqual({ command: 'app_remove_backend_server', args: { baseUrl: 'http://127.0.0.1:4999' } }))
    expect(invokeCalls).toContainEqual({ command: 'app_save_backend_server', args: { baseUrl: 'http://127.0.0.1:4082', name: '' } })
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)
  })

  it('closes a form with Cancel or Escape and puts focus back on what opened it', async () => {
    const user = userEvent.setup()
    const onOpenChange = mock((..._args: unknown[]) => {})
    render(<AppBackendDialog open onOpenChange={onOpenChange} />)

    const edit = await screen.findByRole('button', { name: 'Edit Local CLI' })
    await user.click(edit)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Edit Local CLI' })).toBeNull()
    // Escape closed the form, not the dialog around it.
    expect(onOpenChange).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(edit))

    await openAddForm(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText(/server url/i)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a server' })))
  })

  it('removes a saved server', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const removeButtons = await screen.findAllByRole('button', { name: /^Remove / })
    await user.click(removeButtons[0])
    await user.click(await screen.findByRole('button', { name: 'Remove server' }))

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
    await openAddForm(user)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4999')
    await user.click(screen.getByRole('button', { name: 'Test' }))

    expect(await screen.findByText(/Server did not respond to \/api\/health\/live/)).toBeTruthy()
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:5999')
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)
  })

  it('opens no form by itself: Add a server is a button', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByRole('button', { name: 'Add a server' })).toBeTruthy()
    expect(screen.queryByLabelText(/server url/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull()
  })

  it('switches to a saved server only from its explicit Use button', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText(/server name/i), 'Stale typed name')
    await user.type(screen.getByLabelText(/access key/i), 'stale-key')
    await user.click(await screen.findByRole('button', { name: 'Use Local CLI' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Local CLI', persist: true },
    })
  })

  it('stores the typed access key after a successful connection test', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText(/access key/i), 'secret')
    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4082')
    await user.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => expect(screen.getByText('Connection successful.')).toBeTruthy())
    expect(window.localStorage.getItem('openagentd.accessKey:http://127.0.0.1:4082')).toBe('secret')
    expect(window.localStorage.getItem('openagentd.accessKey')).toBeNull()
  })

  it('shows a local-specific failure message for localhost URLs', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText(/server url/i), 'http://127.0.0.1:4999')
    await user.click(screen.getByRole('button', { name: 'Test' }))

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
    const title = screen.getByRole('heading', { name: 'Server' })
    await user.click(title)

    expect(onOpenChangeMock).not.toHaveBeenCalled()
  })

  it('fills and tests a scanned server but connects only on Save and use', async () => {
    const user = userEvent.setup()
    const prefill = { baseUrl: 'http://127.0.0.1:4082', accessKey: 'scanned-key' }
    render(<AppBackendDialog open onOpenChange={() => {}} prefill={prefill} />)

    expect(await screen.findByText(/Scanned from another device/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Connection successful.')).toBeTruthy())
    expect((screen.getByLabelText(/server url/i) as HTMLInputElement).value).toBe('http://127.0.0.1:4082')
    expect((screen.getByLabelText(/access key/i) as HTMLInputElement).value).toBe('scanned-key')
    expect((screen.getByLabelText(/server name/i) as HTMLInputElement).value).toBe('127.0.0.1')
    const authCheck = fetchCalls.find((call) => call.url === 'http://127.0.0.1:4082/api/auth/check')
    expect(new Headers(authCheck?.init?.headers).get('Authorization')).toBe('Bearer scanned-key')
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Save and use' }))
    await waitFor(() => expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: '127.0.0.1', persist: true },
    }))
  })

  it('reports a scanned server that does not answer', async () => {
    const prefill = { baseUrl: 'http://127.0.0.1:4999', accessKey: 'scanned-key' }
    render(<AppBackendDialog open onOpenChange={() => {}} prefill={prefill} />)

    expect(await screen.findByText(/Server did not respond/)).toBeTruthy()
    expect(invokeCalls.some((call) => call.command === 'app_use_external_backend')).toBe(false)
  })

  it('renders the same panel as the Settings → Server page', async () => {
    render(<ConnectionSettingsPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Server' })).toBeTruthy()
    expect(await screen.findByText('Built-in server')).toBeTruthy()
    expect(screen.getByText('Local CLI')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a server' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit Local CLI' })).toBeTruthy()
  })
})

describe('the server list: select, use, in use, one close', () => {
  it('has one close button, in the header, called Close', async () => {
    const user = userEvent.setup()
    const onOpenChange = mock((..._args: unknown[]) => {})
    render(<AppBackendDialog open onOpenChange={onOpenChange} />)
    await screen.findByText('Built-in server')

    expect(screen.getAllByRole('button', { name: /^close/i })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Close server settings' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('names the dialog Server, like the Settings section', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await screen.findByText('Built-in server')
    expect(screen.getByRole('dialog', { name: 'Server' })).toBeTruthy()
    expect(screen.queryByText('Backend connection')).toBeNull()
  })

  it('says what the built-in server is doing in its row, with nothing to edit', async () => {
    statusPayload = { ...statusPayload, base_url: 'http://127.0.0.1:49545', mode: 'bundled', sidecar_running: true, external: false }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('Built-in server', { selector: 'span' })).closest('[data-server-row]') as HTMLElement
    expect(within(row).getByText('Runs inside this app · Running')).toBeTruthy()
    expect(within(row).getByText('In use')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /^Edit/ })).toBeNull()
  })

  it('marks the server the app talks to "In use", and offers Use only on the others', async () => {
    statusPayload = { ...statusPayload, base_url: 'http://127.0.0.1:4082' }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const active = (await screen.findByText('Local CLI')).closest('[data-server-row]') as HTMLElement
    expect(within(active).getByText('In use')).toBeTruthy()
    expect(within(active).queryByRole('button', { name: /^Use / })).toBeNull()
    // Nothing says "Active" any more, and the other servers can be switched to.
    expect(screen.queryByText('Active')).toBeNull()
    expect(screen.getByRole('button', { name: 'Use http://127.0.0.1:4999' })).toBeTruthy()
    expect(screen.getAllByText('In use')).toHaveLength(1)
  })

  it('has no separate current-server card: the connected row is the only place that says so', async () => {
    statusPayload = { ...statusPayload, base_url: 'http://127.0.0.1:4082' }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const active = (await screen.findByText('Local CLI')).closest('[data-server-row]') as HTMLElement
    expect(screen.queryByText(/^Current:/)).toBeNull()
    expect(screen.queryByText('Saved server')).toBeNull()
    // The built-in server is not connected, so its title appears once, with no chip of its own.
    expect(screen.getAllByText('Built-in server')).toHaveLength(1)
    // Every server URL appears once: the connected row holds its own, nothing repeats it above the list.
    expect(screen.getAllByText('http://127.0.0.1:4082')).toHaveLength(1)
    const badge = within(active).getByText('In use').closest('[data-slot="chip"]')
    expect(badge?.getAttribute('data-tone')).toBe('neutral')
    expect(screen.getAllByText('In use')).toHaveLength(1)
  })

  it('shows the built-in server address on its row when the app is connected to it', async () => {
    statusPayload = { ...statusPayload, base_url: 'http://127.0.0.1:49545', mode: 'bundled', sidecar_running: true, external: false }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('Built-in server', { selector: 'span' })).closest('[data-server-row]') as HTMLElement
    expect(within(row).getByText('http://127.0.0.1:49545')).toBeTruthy()
    expect(within(row).getByText('In use').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(screen.queryByText(/^Current:/)).toBeNull()
    expect(screen.queryByText('Saved server')).toBeNull()
    expect(screen.getAllByText('In use')).toHaveLength(1)
  })

  it('lists a connected server that is not saved, as its own In use row', async () => {
    statusPayload = { ...statusPayload, base_url: 'http://10.0.0.9:4082' }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('http://10.0.0.9:4082')).closest('[data-server-row]') as HTMLElement
    expect(within(row).getByText('In use')).toBeTruthy()
    expect(within(row).getByText('Not in your saved servers')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /^Use / })).toBeNull()
    // Its health is checked like any other row's (the test server answers only on 4082).
    await waitFor(() => expect(within(row).getByLabelText('Offline')).toBeTruthy())
    expect(screen.queryByText(/^Current:/)).toBeNull()
    expect(screen.getAllByText('In use')).toHaveLength(1)
  })

  it('says "Start and use" for a stopped built-in server, and switches to it', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Start and use' }))
    await waitFor(() => expect(invokeCalls).toContainEqual({ command: 'app_use_bundled_backend', args: undefined }))
  })

  it('calls the check Test and the save Save and use, so a button never has two names', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)
    expect(screen.getByRole('button', { name: 'Test' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save and use' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save and connect' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  })
})

describe('saved server Enabled switch (desktop app)', () => {
  const platform = Object.getOwnPropertyDescriptor(window.navigator, 'platform')

  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    if (platform) Object.defineProperty(window.navigator, 'platform', platform)
    else delete (window.navigator as unknown as Record<string, unknown>).platform
  })

  it('shows each saved server as enabled or not, and turns watching on from the switch', async () => {
    const user = userEvent.setup()
    statusPayload.servers[1].enabled = true
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const local = await screen.findByRole('switch', { name: 'Enable Local CLI' })
    expect(local.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Enable http://127.0.0.1:4999' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Disabled · not watched')).toBeTruthy()

    await user.click(local)
    await waitFor(() => expect(invokeCalls).toContainEqual({
      command: 'app_set_backend_server_enabled',
      args: { baseUrl: 'http://127.0.0.1:4082', enabled: true },
    }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Local CLI' }).getAttribute('aria-checked')).toBe('true'))
    expect(screen.queryByText('Disabled · not watched')).toBeNull()
  })

  it('says how the background connection is doing', async () => {
    statusPayload.servers[0].enabled = true
    statusPayload.servers[1].enabled = true
    watchStates = { 'http://127.0.0.1:4082': 'connected', 'http://127.0.0.1:4999': 'key_rejected' }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Watching')).toBeTruthy()
    expect(await screen.findByText('Access key rejected · update it with Edit')).toBeTruthy()
  })

  it('shows no switch outside the desktop app', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('Local CLI')
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('Disabled · not watched')).toBeNull()
  })
})
