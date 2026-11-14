import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppBackendDialog } from '@/components/AppBackendDialog'
import { ConnectionSettingsPage } from '@/components/settings/pages/settings.connection'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'

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
  computer_names: {} as Record<string, string>,
}

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  const commandArgs = args[1]
  invokeCalls.push({ command, args: commandArgs })
  if (command === 'app_backend_status') return statusPayload
  if (command === 'app_save_backend_server') return statusPayload
  if (command === 'app_remove_backend_server') return statusPayload
  if (command === 'app_server_watch_states') return watchStates
  if (command === 'app_remember_computer_name') {
    const args = commandArgs as { key: string; name: string }
    statusPayload = { ...statusPayload, computer_names: { ...statusPayload.computer_names, [args.key]: args.name } }
    return statusPayload
  }
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
    computer_names: {},
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
  queryClient.removeQueries({ queryKey: queryKeys.health() })
  queryClient.removeQueries({ queryKey: queryKeys.backendStatus() })
  window.localStorage.clear()
  delete window.__OAD_TOKEN__
  globalThis.fetch = originalFetch
  window.fetch = originalWindowFetch
  window.location.reload = originalReload
  delete window.__OAD_API_BASE_URL__
})

/** "Add a computer by address" is a button: the form opens only when asked. */
async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add a computer by address' }))
}

/** Edit, Remove and the watch switch of a computer added by address are in its Details. */
async function openDetails(user: ReturnType<typeof userEvent.setup>, label: string) {
  // The row of this computer says "Details of this computer".
  const name = label === 'This computer' ? 'Details of this computer' : `Details of ${label}`
  await user.click(await screen.findByRole('button', { name }))
  return screen.findByRole('dialog', { name: label })
}

async function openEditForm(user: ReturnType<typeof userEvent.setup>, label: string) {
  const details = await openDetails(user, label)
  await user.click(within(details).getByRole('button', { name: 'Edit' }))
  return screen.getByRole('group', { name: `Edit ${label}` })
}

const useCalls = () => invokeCalls.filter((call) => call.command === 'app_use_external_backend')

describe('AppBackendDialog', () => {
  it('installs browser auth for a keyed backend after switching to it', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText('Access key'), 'secret')
    await user.type(screen.getByLabelText('Address'), 'http://127.0.0.1:4082')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
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

    await screen.findByText('This computer')
    await user.click(await screen.findByRole('button', { name: 'Use Local CLI' }))

    await screen.findByText('switch failed')
    expect(window.__OAD_TOKEN__).toBe('bundled-token')
  })

  it('lists this computer and the ones added by address in one list, with live online/offline indicators', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('This computer')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Computers' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Servers' })).toBeNull()
    expect(screen.getByText('Local CLI')).toBeTruthy()
    // A named computer's row has its name and one status line; its address is in Details.
    expect(screen.queryByText('http://127.0.0.1:4082')).toBeNull()
    expect(screen.getByText('http://127.0.0.1:4999')).toBeTruthy()

    const rowOf = (text: string) => screen.getByText(text).closest('[data-server-row]') as HTMLElement
    await waitFor(() => expect(within(rowOf('Local CLI')).getByLabelText('Online')).toBeTruthy())
    // The line also says where the row comes from.
    expect(within(rowOf('Local CLI')).getByText('Online · added by address')).toBeTruthy()
    await waitFor(() => expect(within(rowOf('http://127.0.0.1:4999')).getByLabelText("Can't reach")).toBeTruthy())
    expect(within(rowOf('http://127.0.0.1:4999')).getByText("Can't reach · added by address")).toBeTruthy()
  })

  it('keeps a row to Use and Details: Edit, Remove and Stop are in Details', async () => {
    statusPayload = { ...statusPayload, sidecar_running: true }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('Local CLI')).closest('[data-server-row]') as HTMLElement
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['Use', 'Details'])
    const own = screen.getByText('This computer').closest('[data-server-row]') as HTMLElement
    expect(within(own).getAllByRole('button').map((button) => button.textContent)).toEqual(['Use', 'Details'])
  })

  it('hides the row of this computer when the shell does not support bundled backends', async () => {
    statusPayload = { ...statusPayload, supports_bundled: false }

    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Local CLI')).toBeTruthy()
    expect(screen.queryByText('This computer')).toBeNull()
  })

  it('blocks an incomplete address before invoking a backend switch command', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText('Address'), 'localhost')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText('Enter a full address, including http:// or https://.')).toBeTruthy()
    expect(useCalls()).toHaveLength(0)
  })

  it('stops this computer from its Details while the app is on it, after asking', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://127.0.0.1:49545',
      mode: 'bundled',
      sidecar_running: true,
      external: false,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('This computer')
    expect(screen.queryByRole('button', { name: 'Start and use' })).toBeNull()
    const details = await openDetails(user, 'This computer')
    await user.click(within(details).getByRole('button', { name: 'Stop…' }))
    expect(await screen.findByText('Stop OpenAgentd on this computer?')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Stop' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_stop_bundled_backend',
        args: undefined,
      })
    })
  })

  it('stops this computer from its Details while another one is in use', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://192.168.1.20:4082',
      mode: 'external',
      sidecar_running: true,
      external: true,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('This computer')
    expect(screen.queryByRole('button', { name: 'Start and use' })).toBeNull()
    const details = await openDetails(user, 'This computer')
    await user.click(within(details).getByRole('button', { name: 'Stop…' }))
    await user.click(await screen.findByRole('button', { name: 'Stop' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_stop_bundled_backend',
        args: undefined,
      })
    })
  })

  it('offers Use to switch back to this computer while it runs and another one is in use', async () => {
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

    await screen.findByText('This computer')
    await user.click(await screen.findByRole('button', { name: 'Use this computer' }))

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

  it('lets users recover from an unreachable computer by choosing this one while it is stopped', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload,
      base_url: 'http://192.168.1.20:4082',
      mode: 'external',
      sidecar_running: false,
      external: true,
    }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await screen.findByText('This computer')
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

  it('tests the address and key with one Connect, then saves it and switches to it', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    // Paste each value in one input event so the parallel suite does not
    // spend its 5 s test budget dispatching every character.
    await user.click(screen.getByLabelText('Address'))
    await user.paste('http://127.0.0.1:4082')
    await user.click(screen.getByLabelText('Access key'))
    await user.paste('secret')
    await user.click(screen.getByLabelText('Name'))
    await user.paste('Workstation')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Workstation', persist: true },
    })
    // The key was checked with the computer before anything was saved.
    const authCheck = fetchCalls.find((call) => call.url === 'http://127.0.0.1:4082/api/auth/check')
    expect(new Headers(authCheck?.init?.headers).get('Authorization')).toBe('Bearer secret')
    expect(window.localStorage.getItem('openagentd.accessKey:http://127.0.0.1:4082')).toBe('secret')
    expect(window.localStorage.getItem('openagentd.accessKey')).toBeNull()
  })

  it('renames a computer in place from Edit in its Details, without switching to it', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const form = await openEditForm(user, 'Local CLI')
    expect((within(form).getByLabelText('Address') as HTMLInputElement).value).toBe('http://127.0.0.1:4082')
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Local CLI')

    // A new name is not tested: nothing about reaching it changed.
    await user.clear(within(form).getByLabelText('Name'))
    await user.type(within(form).getByLabelText('Name'), 'Renamed CLI')
    const checksBefore = fetchCalls.length
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls).toContainEqual({
      command: 'app_save_backend_server',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Renamed CLI' },
    }))
    expect(fetchCalls.slice(checksBefore).some((call) => call.url.endsWith('/api/auth/check'))).toBe(false)
    expect(useCalls()).toHaveLength(0)
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit Local CLI' })).toBeNull())
  })

  it('opens the edit form right under its row, apart from the add form', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const form = await openEditForm(user, 'Local CLI')
    const row = screen.getByRole('button', { name: 'Details of Local CLI', hidden: true }).closest('[data-server-row]') as HTMLElement
    expect(row.nextElementSibling).toBe(form)
    // The add form is a different place: opening it closes the edit form.
    await user.click(screen.getByRole('button', { name: 'Add a computer by address', hidden: true }))
    expect(screen.queryByRole('group', { name: 'Edit Local CLI' })).toBeNull()
    const add = screen.getByRole('group', { name: 'Add a computer by address', hidden: true })
    expect(add.nextElementSibling).toBeNull()
  })

  it('tests a new address on Save, then replaces the old entry', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const form = await openEditForm(user, 'http://127.0.0.1:4999')
    const url = within(form).getByLabelText('Address')
    await user.clear(url)
    await user.click(url)
    await user.paste('http://127.0.0.1:4082')
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls).toContainEqual({ command: 'app_remove_backend_server', args: { baseUrl: 'http://127.0.0.1:4999' } }))
    expect(invokeCalls).toContainEqual({ command: 'app_save_backend_server', args: { baseUrl: 'http://127.0.0.1:4082', name: '' } })
    expect(fetchCalls.some((call) => call.url === 'http://127.0.0.1:4082/api/auth/check')).toBe(true)
    expect(useCalls()).toHaveLength(0)
  })

  it('saves nothing when the new address does not answer, and says why in the form', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const form = await openEditForm(user, 'Local CLI')
    const url = within(form).getByLabelText('Address')
    await user.clear(url)
    await user.click(url)
    await user.paste('http://127.0.0.1:4998')
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    expect(await within(form).findByRole('alert')).toBeTruthy()
    expect(invokeCalls.some((call) => call.command === 'app_save_backend_server' || call.command === 'app_remove_backend_server')).toBe(false)
  })

  it('closes a form with Cancel or Escape and puts focus back on what opened it', async () => {
    const user = userEvent.setup()
    const onOpenChange = mock((..._args: unknown[]) => {})
    render(<AppBackendDialog open onOpenChange={onOpenChange} />)

    await openEditForm(user, 'Local CLI')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Edit Local CLI' })).toBeNull()
    // Escape closed the form, not the dialog around it.
    expect(onOpenChange).not.toHaveBeenCalled()
    // Back on the row's Details, which is where Edit was.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details of Local CLI', hidden: true })))

    await user.click(screen.getByRole('button', { name: 'Add a computer by address', hidden: true }))
    await user.click(screen.getByRole('button', { name: 'Cancel', hidden: true }))
    expect(screen.queryByLabelText('Address')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a computer by address', hidden: true })))
  })

  it('removes a computer from its Details, after asking', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const details = await openDetails(user, 'Local CLI')
    await user.click(within(details).getByRole('button', { name: 'Remove…' }))
    expect(await screen.findByText('Remove Local CLI?')).toBeTruthy()
    expect(invokeCalls.some((call) => call.command === 'app_remove_backend_server')).toBe(false)
    await user.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(invokeCalls).toContainEqual({
        command: 'app_remove_backend_server',
        args: { baseUrl: 'http://127.0.0.1:4082' },
      })
    })
  })

  it('says why in place and does not switch when nothing answers at the address', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText('Address'), 'http://127.0.0.1:4999')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText(/Nothing answered at that address/)).toBeTruthy()
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:5999')
    expect(useCalls()).toHaveLength(0)
    // The form stays open with what was typed, to fix and try again.
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('http://127.0.0.1:4999')
  })

  it('opens no form by itself: Add a computer by address is a button', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByRole('button', { name: 'Add a computer by address' })).toBeTruthy()
    expect(screen.queryByLabelText('Address')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  })

  it('switches to a listed computer only from its explicit Use button', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText('Name'), 'Stale typed name')
    await user.type(screen.getByLabelText('Access key'), 'stale-key')
    await user.click(await screen.findByRole('button', { name: 'Use Local CLI' }))

    await waitFor(() => expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082'))
    expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: 'Local CLI', persist: true },
    })
  })

  it('shows a local-specific failure message for localhost addresses', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)

    await user.type(screen.getByLabelText('Address'), 'http://127.0.0.1:4999')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

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

  it('fills and tests a scanned computer but connects only on Connect', async () => {
    const user = userEvent.setup()
    const prefill = { baseUrl: 'http://127.0.0.1:4082', accessKey: 'scanned-key' }
    render(<AppBackendDialog open onOpenChange={() => {}} prefill={prefill} />)

    expect(await screen.findByText(/Scanned from another device/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Connection successful.')).toBeTruthy())
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('http://127.0.0.1:4082')
    expect((screen.getByLabelText('Access key') as HTMLInputElement).value).toBe('scanned-key')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('127.0.0.1')
    const authCheck = fetchCalls.find((call) => call.url === 'http://127.0.0.1:4082/api/auth/check')
    expect(new Headers(authCheck?.init?.headers).get('Authorization')).toBe('Bearer scanned-key')
    expect(useCalls()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(invokeCalls).toContainEqual({
      command: 'app_use_external_backend',
      args: { baseUrl: 'http://127.0.0.1:4082', name: '127.0.0.1', persist: true },
    }))
  })

  it('reports a scanned computer that does not answer', async () => {
    const prefill = { baseUrl: 'http://127.0.0.1:4999', accessKey: 'scanned-key' }
    render(<AppBackendDialog open onOpenChange={() => {}} prefill={prefill} />)

    expect(await screen.findByText(/Nothing answered at that address/)).toBeTruthy()
    expect(useCalls()).toHaveLength(0)
  })

  it('renders the same panel as the Settings → Server page', async () => {
    render(<ConnectionSettingsPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Server' })).toBeTruthy()
    expect(await screen.findByText('This computer')).toBeTruthy()
    expect(screen.getByText('Local CLI')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a computer by address' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Details of Local CLI' })).toBeTruthy()
  })
})

describe('the list of computers: use, in use, one close', () => {
  it('has one close button, in the header, called Close', async () => {
    const user = userEvent.setup()
    const onOpenChange = mock((..._args: unknown[]) => {})
    render(<AppBackendDialog open onOpenChange={onOpenChange} />)
    await screen.findByText('This computer')

    expect(screen.getAllByRole('button', { name: /^close/i })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Close server settings' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('names the dialog Server, like the Settings section', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await screen.findByText('This computer')
    expect(screen.getByRole('dialog', { name: 'Server' })).toBeTruthy()
    expect(screen.queryByText('Backend connection')).toBeNull()
  })

  it('says what this computer is doing in its row, with nothing to edit', async () => {
    statusPayload = { ...statusPayload, base_url: 'http://127.0.0.1:49545', mode: 'bundled', sidecar_running: true, external: false }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('This computer', { selector: 'span' })).closest('[data-server-row]') as HTMLElement
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
    // This computer is not the one in use, so its title appears once, with no chip of its own.
    expect(screen.getAllByText('This computer')).toHaveLength(1)
    // The connected row says so with its chip; no address is repeated above the list or on the row.
    expect(screen.queryByText('http://127.0.0.1:4082')).toBeNull()
    const badge = within(active).getByText('In use').closest('[data-slot="chip"]')
    expect(badge?.getAttribute('data-tone')).toBe('neutral')
    expect(screen.getAllByText('In use')).toHaveLength(1)
  })

  it('keeps the address of this computer off its row, under Details', async () => {
    const user = userEvent.setup()
    statusPayload = { ...statusPayload, base_url: 'http://127.0.0.1:49545', mode: 'bundled', sidecar_running: true, external: false }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('This computer', { selector: 'span' })).closest('[data-server-row]') as HTMLElement
    expect(within(row).queryByText('http://127.0.0.1:49545')).toBeNull()
    expect(within(row).getByText('In use').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(screen.queryByText(/^Current:/)).toBeNull()
    expect(screen.queryByText('Saved server')).toBeNull()
    expect(screen.getAllByText('In use')).toHaveLength(1)

    await user.click(within(row).getByRole('button', { name: 'Details of this computer' }))
    const details = await screen.findByRole('dialog', { name: 'This computer' })
    expect(details.textContent).toContain('Addresshttp://127.0.0.1:49545')
  })

  it('names this computer from its Details', async () => {
    const user = userEvent.setup()
    statusPayload = {
      ...statusPayload, base_url: 'http://127.0.0.1:49545', mode: 'bundled', sidecar_running: true, external: false,
      computer_names: { 'built-in': 'studio-mini' },
    }
    window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:49545'
    queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.54.0', capabilities: ['api.server_name'] })
    const answerName = mock((...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined
      fetchCalls.push({ url: String(args[0]), init })
      if (init?.method === 'PUT') return Promise.resolve(Response.json({ name: 'Work', default: 'studio-mini', custom: true }))
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    globalThis.fetch = answerName as typeof fetch
    window.fetch = answerName as typeof window.fetch
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.click(await screen.findByRole('button', { name: 'Details of this computer' }))
    const details = await screen.findByRole('dialog', { name: 'This computer' })
    expect(details.textContent).toContain('Namestudio-mini')
    await user.click(within(details).getByRole('button', { name: 'Rename' }))
    const input = within(details).getByRole('textbox', { name: 'Name' })
    await user.clear(input)
    await user.type(input, 'Work')
    await user.click(within(details).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls).toContainEqual({ command: 'app_remember_computer_name', args: { key: 'built-in', name: 'Work' } }))
    const put = fetchCalls.find((call) => call.init?.method === 'PUT')
    expect(put?.url).toBe('http://127.0.0.1:49545/api/server/name')
    await waitFor(() => expect(details.textContent).toContain('NameWork'))
  })

  it('says where this computer is renamed while the app is on another one', async () => {
    const user = userEvent.setup()
    statusPayload = { ...statusPayload, sidecar_running: true, computer_names: { 'built-in': 'studio-mini' } }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    await user.click(await screen.findByRole('button', { name: 'Details of this computer' }))
    const details = await screen.findByRole('dialog', { name: 'This computer' })
    expect(details.textContent).toContain('Namestudio-mini')
    expect(within(details).queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(details.textContent).toContain('Switch to this computer to rename it.')
    // Its address is not this window's: none is shown.
    expect(details.textContent).not.toContain('Address')
  })

  it('lists a connected computer that is not saved, as its own In use row', async () => {
    statusPayload = { ...statusPayload, base_url: 'http://10.0.0.9:4082' }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('http://10.0.0.9:4082')).closest('[data-server-row]') as HTMLElement
    expect(within(row).getByText('In use')).toBeTruthy()
    expect(within(row).getByText('Not saved in this list')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /^Use / })).toBeNull()
    // Its health is checked like any other row's (the test server answers only on 4082).
    await waitFor(() => expect(within(row).getByLabelText("Can't reach")).toBeTruthy())
    expect(screen.queryByText(/^Current:/)).toBeNull()
    expect(screen.getAllByText('In use')).toHaveLength(1)
  })

  it('titles a connected computer that is not saved by its own name, with the address under Details', async () => {
    const user = userEvent.setup()
    statusPayload = { ...statusPayload, base_url: 'http://10.0.0.9:4082', computer_names: { 'http://10.0.0.9:4082': 'build-box' } }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const row = (await screen.findByText('build-box')).closest('[data-server-row]') as HTMLElement
    expect(within(row).getByText('Not saved in this list')).toBeTruthy()
    expect(screen.queryByText('http://10.0.0.9:4082')).toBeNull()
    await user.click(within(row).getByRole('button', { name: 'Details of build-box' }))
    const details = await screen.findByRole('dialog', { name: 'build-box' })
    expect(details.textContent).toContain('Addresshttp://10.0.0.9:4082')
  })

  it('titles a saved server by its computer as soon as the name is learned, while the list is shown', async () => {
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    // Just added and never named: all the app has is its address.
    const row = (await screen.findByText('http://127.0.0.1:4999')).closest('[data-server-row]') as HTMLElement

    // What reading the name does (`ComputerNameSync`): the shell remembers it,
    // and the app's status carries it.
    queryClient.setQueryData(queryKeys.backendStatus(), { ...statusPayload, computer_names: { 'http://127.0.0.1:4999': 'build-box' } })

    await waitFor(() => expect(within(row).getByText('build-box')).toBeTruthy())
    expect(screen.queryByText('http://127.0.0.1:4999')).toBeNull()
  })

  it('says "Start and use" while this computer is stopped, and switches to it', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Start and use' }))
    await waitFor(() => expect(invokeCalls).toContainEqual({ command: 'app_use_bundled_backend', args: undefined }))
  })

  it('gives the add form one button, Connect, as a key has', async () => {
    const user = userEvent.setup()
    render(<AppBackendDialog open onOpenChange={() => {}} />)
    await openAddForm(user)
    const form = screen.getByRole('group', { name: 'Add a computer by address' })
    expect(within(form).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Connect'])
    expect(within(form).queryByText('Test the server to enable saving.')).toBeNull()
  })
})

describe('watching a computer in the background (desktop app)', () => {
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

  it('turns watching on from the switch in a computer’s Details', async () => {
    const user = userEvent.setup()
    statusPayload.servers[1].enabled = true
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    // The row itself has no switch: it is one of the things Details holds.
    const row = (await screen.findByText('Local CLI')).closest('[data-server-row]') as HTMLElement
    expect(within(row).queryByRole('switch')).toBeNull()

    const details = await openDetails(user, 'Local CLI')
    const watch = within(details).getByRole('switch', { name: 'Watch Local CLI in the background' })
    expect(watch.getAttribute('aria-checked')).toBe('false')

    await user.click(watch)
    await waitFor(() => expect(invokeCalls).toContainEqual({
      command: 'app_set_backend_server_enabled',
      args: { baseUrl: 'http://127.0.0.1:4082', enabled: true },
    }))
    await waitFor(() => expect(within(details).getByRole('switch', { name: 'Watch Local CLI in the background' }).getAttribute('aria-checked')).toBe('true'))
  })

  it('shows a watched computer as watched in its Details', async () => {
    const user = userEvent.setup()
    statusPayload.servers[1].enabled = true
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const details = await openDetails(user, 'http://127.0.0.1:4999')
    expect(within(details).getByRole('switch', { name: 'Watch http://127.0.0.1:4999 in the background' }).getAttribute('aria-checked')).toBe('true')
    expect(details.textContent).toContain('Addresshttp://127.0.0.1:4999')
  })

  it('says how the background connection is doing, and nothing about one that is not watched', async () => {
    statusPayload.servers[0].enabled = true
    watchStates = { 'http://127.0.0.1:4082': 'connected' }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Watching')).toBeTruthy()
    // Not watched: its line says whether it answers, like any other row.
    const other = screen.getByText('http://127.0.0.1:4999').closest('[data-server-row]') as HTMLElement
    await waitFor(() => expect(within(other).getByText("Can't reach · added by address")).toBeTruthy())
    expect(screen.queryByText(/not watched/i)).toBeNull()
  })

  it('points a rejected access key at Details, where Edit is', async () => {
    statusPayload.servers[1].enabled = true
    watchStates = { 'http://127.0.0.1:4999': 'key_rejected' }
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    expect(await screen.findByText('Access key rejected · change it in Details')).toBeTruthy()
  })

  it('offers no watching outside the desktop app', async () => {
    const user = userEvent.setup()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    render(<AppBackendDialog open onOpenChange={() => {}} />)

    const details = await openDetails(user, 'Local CLI')
    expect(within(details).queryByRole('switch')).toBeNull()
    expect(within(details).getByRole('button', { name: 'Edit' })).toBeTruthy()
  })
})
