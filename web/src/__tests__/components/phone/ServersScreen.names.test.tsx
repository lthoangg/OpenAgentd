/**
 * Names on the Servers screen: a computer of the account is listed by the
 * name it gave for itself (once the app has been on it), a saved server by
 * your name or its computer's, and no row carries a key or an address. The
 * key, the system and the role are under Details, where any computer of
 * the account is also renamed. The shell is faked at `invoke`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DeviceRow } from '@/api/phone-cloud'
import type { AppBackendStatus } from '@/lib/app-backend'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

let backend: AppBackendStatus
let devices: DeviceRow[] = []
let remembered: Array<{ key: string; name: string }> = []
let renamedThroughLink: Array<{ deviceId: string; name: string }> = []
let linkRename: 'ok' | 'old' = 'ok'
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: { key: string; name: string; deviceId: string }) => {
    if (command === 'app_backend_status') return backend
    if (command === 'cloud_rename_computer' && args) {
      if (linkRename === 'old') throw 'Update OpenAgentd on this computer to name it.'
      renamedThroughLink.push({ deviceId: args.deviceId, name: args.name })
      return { name: args.name || 'mini-host', default: 'mini-host', custom: Boolean(args.name) }
    }
    if (command === 'app_server_watch_states') return {}
    if (command === 'cloud_status') return { state: 'connected', fingerprint: 'AA11 BB22', signer: true }
    if (command === 'cloud_devices') return devices
    if (command === 'cloud_pending') return []
    if (command === 'cloud_link_route') return { route: 'direct' }
    if (command === 'app_remember_computer_name' && args) {
      remembered.push({ key: args.key, name: args.name })
      const names = { ...backend.computer_names }
      if (args.name) names[args.key] = args.name
      else delete names[args.key]
      backend = { ...backend, computer_names: names }
      return backend
    }
    return null
  },
}))

const { ServersScreen } = await import('@/components/phone/ServersScreen')
const { queryClient } = await import('@/lib/query-client')
const { queryKeys } = await import('@/queries/keys')

const BRIDGE = 'http://127.0.0.1:5999'
const NAS = 'http://192.168.1.30:4082'
const ME: DeviceRow = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true, online: null }
const MAC: DeviceRow = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true, online: true }
const MINI: DeviceRow = { device_id: 'dev-mini', fingerprint: '81BC 77E0', signer: false, me: false, kind: 'macos', server: true, client: false, online: true }
const BOX: DeviceRow = { device_id: 'dev-box', fingerprint: 'C2D0 5A19', signer: false, me: false, kind: 'linux', server: true, client: false, online: false }

function app(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return {
    base_url: BRIDGE, mode: 'external', sidecar_running: false, external: true, supports_bundled: false,
    servers: [{ base_url: NAS, name: 'Office NAS' }],
    account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' },
    computer_names: { 'dev-mac': 'Work', 'dev-mini': 'Personal' },
    ...overrides,
  }
}

const originalFetch = globalThis.fetch
let requests: Array<{ url: string; method: string; body: string | null }> = []
let renameFails = false

beforeEach(() => {
  backend = app()
  devices = [ME, MAC, MINI, BOX]
  remembered = []
  renamedThroughLink = []
  linkRename = 'ok'
  requests = []
  renameFails = false
  window.__OAD_API_BASE_URL__ = BRIDGE
  // What the running app already knows about the server in use.
  queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.54.0', capabilities: ['api.server_name'] })
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : null })
    if (url.endsWith('/server/name') && method === 'PUT') {
      if (renameFails) return Response.json({ detail: 'name must be a string' }, { status: 422 })
      const name = (JSON.parse(String(init?.body)) as { name: string }).name
      return Response.json({ name: name || 'studio-mini', default: 'studio-mini', custom: Boolean(name) })
    }
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-server-row]'))
/** The row titled `name` (an open Details dialog carries the name too). */
const rowOf = (name: string) => {
  const row = rows().find((candidate) => within(candidate).queryByText(name))
  if (!row) throw new Error(`no row titled ${name}`)
  return row
}

describe('names on the Servers screen', () => {
  it('lists each computer by its own name, with no key or address on a row', async () => {
    backend = app({ computer_names: { 'dev-mac': 'Work', 'dev-mini': 'Personal', 'dev-box': 'build-box' } })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Work')
    await screen.findByText('Office NAS')
    expect(within(rowOf('Work')).getByText('In use')).toBeTruthy()
    expect(within(rowOf('Personal')).getByText('Online')).toBeTruthy()
    expect(within(rowOf('build-box')).getByText('Offline')).toBeTruthy()
    // The saved server: its name and one status line, not its address.
    await waitFor(() => expect(within(rowOf('Office NAS')).getByText('Online')).toBeTruthy())
    for (const row of rows()) {
      expect(row.textContent).not.toMatch(/3F9A|81BC|C2D0/)
      expect(row.textContent).not.toContain('://')
      expect(row.textContent).not.toContain('192.168')
    }
  })

  it('titles a computer the app has never been on by its system and key', async () => {
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Work')
    expect(screen.getByText('Linux · C2D0 5A19')).toBeTruthy()
  })

  it('adds the key to a name only while two computers share it', async () => {
    backend = app({ computer_names: { 'dev-mac': 'mini', 'dev-mini': 'mini' } })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('mini · 3F9A 21C4')).toBeTruthy()
    expect(screen.getByText('mini · 81BC 77E0')).toBeTruthy()
  })

  it('names an unnamed saved server by its computer', async () => {
    backend = app({ servers: [{ base_url: NAS, name: null }], computer_names: { [NAS]: 'office-nas' } })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('office-nas')).toBeTruthy()
    expect(screen.queryByText(NAS)).toBeNull()
    expect(screen.getByRole('button', { name: 'Use office-nas' })).toBeTruthy()
  })

  it('keeps the system, the key and the role under Details', async () => {
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Personal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Personal' })
    expect(dialog.textContent).toContain('SystemmacOS')
    expect(dialog.textContent).toContain('Key81BC 77E0')
    expect(dialog.textContent).toContain('RoleServer')
    expect(dialog.textContent).not.toContain('Open this computer to rename it.')
  })

  it('renames a computer that is not in use through its link, without switching to it', async () => {
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Personal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Personal' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Home' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(renamedThroughLink).toEqual([{ deviceId: 'dev-mini', name: 'Home' }]))
    await waitFor(() => expect(remembered).toEqual([{ key: 'dev-mini', name: 'Home' }]))
    // Nothing went over the connection to the computer in use.
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    await waitFor(() => expect(within(rowOf('Home')).getByText('Online')).toBeTruthy())
    expect(within(rowOf('Work')).getByText('In use')).toBeTruthy()
  })

  it('says to update a computer that predates names when renamed through its link', async () => {
    linkRename = 'old'
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Personal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Personal' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Home' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Update OpenAgentd on this computer to name it.')
    expect(remembered).toEqual([])
  })

  it('renames the computer in use, on the computer, and shows the new name', async () => {
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Work' }))
    const dialog = await screen.findByRole('dialog', { name: 'Work' })
    expect(dialog.textContent).toContain('RoleServer and client · approves devices')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Studio' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(remembered).toEqual([{ key: 'dev-mac', name: 'Studio' }]))
    const put = requests.find((request) => request.method === 'PUT')
    expect(put?.url).toBe(`${BRIDGE}/api/server/name`)
    expect(put?.body).toBe(JSON.stringify({ name: 'Studio' }))
    await waitFor(() => expect(within(rowOf('Studio')).getByText('In use')).toBeTruthy())
    expect(rows().some((row) => within(row).queryByText('Work'))).toBe(false)
    // The dialog follows the computer to its new name.
    expect(screen.getByRole('dialog', { name: 'Studio' })).toBeTruthy()
  })

  it('goes back to the computer’s own name when the name is cleared', async () => {
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Work' }))
    const dialog = await screen.findByRole('dialog', { name: 'Work' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(remembered).toEqual([{ key: 'dev-mac', name: 'studio-mini' }]))
    await waitFor(() => expect(within(rowOf('studio-mini')).getByText('In use')).toBeTruthy())
  })

  it('keeps the old name when the computer refuses the new one', async () => {
    renameFails = true
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Work' }))
    const dialog = await screen.findByRole('dialog', { name: 'Work' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Studio' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toBeTruthy()
    expect(remembered).toEqual([])
    expect(within(rowOf('Work')).getByText('In use')).toBeTruthy()
  })

  it('offers no Rename on a server that predates names', async () => {
    queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.53.1', capabilities: [] })
    backend = app({ computer_names: {} })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details of macOS · 3F9A 21C4' }))
    const dialog = await screen.findByRole('dialog', { name: 'macOS · 3F9A 21C4' })
    expect(within(dialog).queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(dialog.textContent).toContain('Update OpenAgentd on this computer to name it.')
  })
})
