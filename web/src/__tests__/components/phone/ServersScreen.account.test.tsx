/**
 * The phone's Servers screen with an account: the Account section in each
 * state (it is there before any server answers), requests to join, the
 * computers with their dots and In use, and the account bridge never shown
 * as a stray 127.0.0.1 server. The shell is faked at `invoke`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

let scanned = ''
mock.module('@tauri-apps/plugin-barcode-scanner', () => ({
  checkPermissions: async () => 'granted',
  requestPermissions: async () => 'granted',
  scan: async () => ({ content: scanned }),
  cancel: async () => {},
  Format: { QRCode: 'QR_CODE' },
}))

type Handler = (args?: Record<string, unknown>) => unknown
let handlers: Record<string, Handler> = {}
let calls: Array<{ command: string; args?: Record<string, unknown> }> = []

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    const handler = handlers[command]
    if (!handler) throw new Error(`unexpected command: ${command}`)
    return handler(args)
  },
}))

const { ServersScreen } = await import('@/components/phone/ServersScreen')
const { NOT_A_CODE } = await import('@/components/phone/useScanAnyCode')
const { ACCOUNT_COMPUTERS_REFRESH_MS } = await import('@/components/phone/AccountComputers')
const { queryClient } = await import('@/lib/query-client')
const { resetPhoneCloudPush } = await import('@/queries/phone-cloud')
const { useAccountRouteStore } = await import('@/stores/useAccountRouteStore')

import type { DeviceRow, PendingRow, PhoneCloudStatus } from '@/api/phone-cloud'
import type { AppBackendStatus } from '@/lib/app-backend'

/** A plain stand-in for window.location whose reload is a mock. */
function fakeLocation(real: Location, reload: () => void): Location {
  const { href, origin, protocol, host, hostname, port, pathname, search, hash } = real
  return { href, origin, protocol, host, hostname, port, pathname, search, hash, reload, assign: () => {}, replace: () => {} } as unknown as Location
}

const BRIDGE = 'http://127.0.0.1:5999'
const LAN = 'http://192.168.1.20:4082'
const NAS = 'http://192.168.1.30:4082'

const GUEST: PhoneCloudStatus = { state: 'guest', notice: null, supported: true }
const CONNECTED: PhoneCloudStatus = { state: 'connected', fingerprint: 'AA11 BB22', signer: true }
const ME: DeviceRow = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true, online: null }
const MAC: DeviceRow = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true, online: true }
const LINUX: DeviceRow = { device_id: 'dev-linux', fingerprint: '9C02 E1B7', signer: false, me: false, kind: 'linux', server: true, client: false, online: false }

function app(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return {
    base_url: NAS,
    mode: 'external',
    sidecar_running: false,
    external: true,
    supports_bundled: false,
    servers: [{ base_url: NAS, name: 'Home NAS' }],
    ...overrides,
  }
}

let status: PhoneCloudStatus

function shell(initial: PhoneCloudStatus, extra: Record<string, Handler> = {}, backend: AppBackendStatus = app()) {
  status = initial
  handlers = {
    cloud_status: () => status,
    cloud_push_register: () => ({}),
    cloud_devices: () => [ME],
    cloud_pending: () => [],
    app_backend_status: () => backend,
    app_server_watch_states: () => ({}),
    secure_get_access_key: () => null,
    ...extra,
  }
}

const originalFetch = globalThis.fetch
/** Origins whose `/api/health/live` does not answer. */
let dead = new Set<string>()

beforeEach(() => {
  calls = []
  dead = new Set()
  window.localStorage.clear()
  resetPhoneCloudPush()
  queryClient.setDefaultOptions({ ...queryClient.getDefaultOptions(), queries: { ...queryClient.getDefaultOptions().queries, retry: false } })
  window.__OAD_API_BASE_URL__ = NAS
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if ([...dead].some((origin) => url.startsWith(origin))) throw new TypeError('Load failed')
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

const ran = (command: string) => calls.filter((call) => call.command === command)
const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
const rowOf = (name: string) => screen.getByText(name).closest('[data-server-row]') as HTMLElement

describe('Account section', () => {
  it('offers a guest the account at the top, before the servers', async () => {
    shell(GUEST)
    render(<ServersScreen active onOpenSessions={() => {}} />)

    expect(await screen.findByText('Use your computers from anywhere')).toBeTruthy()
    expect(screen.getByText('Sign in, and the computers in your account show up here. No address or access key to type.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    // One scanner for an invitation, in place of "I have an invitation" on a phone.
    expect(screen.queryByRole('button', { name: 'I have an invitation' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Scan QR code' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    await screen.findByText('Home NAS')
    expect(headings()).toEqual(['Account', 'Your servers'])
  })

  it('folds into an Account row after Not now, for good, and the row opens the sheet', async () => {
    shell(GUEST)
    const first = render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Use your computers from anywhere')).toBeNull()
    expect(screen.getByText('Not signed in')).toBeTruthy()
    first.unmount()

    render(<ServersScreen active onOpenSessions={() => {}} />)
    const row = await screen.findByRole('button', { name: /Account\s*Not signed in/ })
    expect(screen.queryByText('Use your computers from anywhere')).toBeNull()
    fireEvent.click(row)
    const sheet = await screen.findByRole('dialog', { name: 'Account' })
    expect(within(sheet).getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('shows the notice that made the phone a guest again', async () => {
    shell({ state: 'guest', notice: 'revoked', supported: true })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('This device was removed from your account.')).toBeTruthy()
  })

  it('shows nothing where accounts are not supported', async () => {
    shell({ state: 'guest', notice: null, supported: false })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Home NAS')
    await waitFor(() => expect(ran('cloud_status').length).toBeGreaterThan(0))
    expect(headings()).toEqual(['Your servers'])
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('signs in and opens the Account sheet on the sign-in code', async () => {
    const signingIn: PhoneCloudStatus = { state: 'signing_in', user_code: 'WXYZ-1234', url: 'https://account.openagentd.dev/device', fingerprint: 'AA11 BB22', expires_in: 600 }
    shell(GUEST, { cloud_sign_in: () => { status = signingIn; return signingIn } })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    const sheet = await screen.findByRole('dialog', { name: 'Account' })
    expect(await within(sheet).findByText('WXYZ-1234')).toBeTruthy()
  })

  it('keeps a half-finished sign-in one tap away, on its step', async () => {
    const cases: Array<[PhoneCloudStatus, string]> = [
      [{ state: 'signing_in', user_code: 'WXYZ-1234', url: 'https://account.openagentd.dev/device', fingerprint: 'f', expires_in: 600 }, 'Enter WXYZ-1234 on the account page'],
      [{ state: 'recovery', code: 'AAAAA-BBBBB', check: [1, 2] }, 'Save your recovery code'],
      [{ state: 'joining', fingerprint: 'f', code: '418207' }, 'Compare 418 207 on your other device'],
      [{ state: 'joining', fingerprint: 'f', code: null }, 'Waiting for a device of your account to approve'],
      [{ state: 'invited', fingerprint: 'f', kind: 'ios' }, 'Waiting for your other phone to add this one'],
    ]
    for (const [state, line] of cases) {
      shell(state)
      const view = render(<ServersScreen active onOpenSessions={() => {}} />)
      expect(await screen.findByText('Finish signing in')).toBeTruthy()
      expect(screen.getByText(line)).toBeTruthy()
      view.unmount()
      queryClient.clear()
    }
    shell(cases[1][0])
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /Finish signing in/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Account' })
    expect(await within(sheet).findByText('Save your recovery code.')).toBeTruthy()
  })

  it('says what a signed-in account is: the only device, or how many', async () => {
    shell(CONNECTED)
    const first = render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('This phone · Approves devices')).toBeTruthy()
    first.unmount()
    queryClient.clear()

    shell(CONNECTED, { cloud_devices: () => [ME, MAC, LINUX] })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('3 devices')).toBeTruthy()
    expect(headings()).toEqual(['Account', 'Your computers', 'Your servers'])
  })

  it('says when the account is closing or unavailable', async () => {
    shell({ state: 'closing', fingerprint: 'f', deletes_at: null })
    const first = render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('Scheduled for deletion · remote access paused')).toBeTruthy()
    first.unmount()
    queryClient.clear()
    shell({ state: 'unavailable', fingerprint: 'f' })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('Unavailable · remote access paused')).toBeTruthy()
  })

  it('shows an approver each device that wants to join, with Review', async () => {
    const pending: PendingRow = { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', country: 'VN', created_at: Date.now() - 5_000, expires_at: null, kind: 'macos' }
    shell(CONNECTED, { cloud_pending: () => [pending], cloud_approve_begin: () => new Promise(() => {}) })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('A device wants to join')).toBeTruthy()
    expect(screen.getByText('macOS · 9C02 E1B7 · VN · just now')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('Add this device?')).toBeTruthy()
  })

  it('does not ask a member for requests', async () => {
    shell({ ...CONNECTED, signer: false })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('This phone')).toBeTruthy()
    expect(ran('cloud_pending')).toHaveLength(0)
  })
})

describe('Your computers', () => {
  it('tells a phone with no computer yet how to add one', async () => {
    shell(CONNECTED)
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await screen.findByText('No computers yet')).toBeTruthy()
    expect(screen.getByText('On your computer, open OpenAgentd, go to Settings → Account and sign in. You approve it here.')).toBeTruthy()
  })

  it('shows online and offline from the account, and no dot when it cannot say', async () => {
    shell(CONNECTED, { cloud_devices: () => [ME, MAC, LINUX, { ...LINUX, device_id: 'dev-win', fingerprint: '1111 2222', kind: 'windows', online: null }] })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('macOS · 3F9A 21C4')
    expect(within(rowOf('macOS · 3F9A 21C4')).getByLabelText('Online')).toBeTruthy()
    expect(within(rowOf('macOS · 3F9A 21C4')).getByText('Online · via account')).toBeTruthy()
    expect(within(rowOf('Linux · 9C02 E1B7')).getByLabelText('Offline')).toBeTruthy()
    expect(within(rowOf('Linux · 9C02 E1B7')).getByText('Offline')).toBeTruthy()
    expect(within(rowOf('Windows · 1111 2222')).queryByLabelText(/Online|Offline|Checking/)).toBeNull()
    expect(within(rowOf('Windows · 1111 2222')).getByText('via account')).toBeTruthy()
  })

  it('still tries to open a computer the account calls offline', async () => {
    shell(CONNECTED, { cloud_devices: () => [ME, LINUX], cloud_open_computer: () => { throw new Error('This computer is offline, or not signed in to your account.') } })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use Linux · 9C02 E1B7' }))
    expect((await screen.findByRole('alert')).textContent).toContain('This computer is offline')
    expect(ran('cloud_open_computer')).toHaveLength(1)
  })

  it('marks the computer the app is on through the account In use, with no stray 127.0.0.1 row', async () => {
    const onOpenSessions = mock(() => {})
    shell(CONNECTED, { cloud_devices: () => [ME, MAC, LINUX] }, app({ base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }))
    window.__OAD_API_BASE_URL__ = BRIDGE
    render(<ServersScreen active onOpenSessions={onOpenSessions} />)
    await screen.findByText('Home NAS')
    await screen.findByText('macOS · 3F9A 21C4')
    const mac = rowOf('macOS · 3F9A 21C4')
    expect(within(mac).getByText('In use')).toBeTruthy()
    expect(within(rowOf('Linux · 9C02 E1B7')).queryByText('In use')).toBeNull()
    expect(screen.queryByText('Not in your saved servers')).toBeNull()
    expect(screen.queryByText(BRIDGE)).toBeNull()
    fireEvent.click(within(mac).getByRole('button', { name: 'Open sessions on macOS · 3F9A 21C4' }))
    expect(onOpenSessions).toHaveBeenCalledTimes(1)
  })

  it('titles a computer with the name of the saved LAN server it is', async () => {
    window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
    shell(CONNECTED, { cloud_devices: () => [ME, MAC] }, app({ servers: [{ base_url: NAS, name: 'Home NAS' }, { base_url: LAN, name: 'Studio Mac' }] }))
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Home network or account')
    const row = rowOf('Studio Mac')
    expect(within(row).getByText('Home network or account')).toBeTruthy()
    expect(screen.getAllByText('Studio Mac')).toHaveLength(1)
  })

  it('refreshes the computers every 30 s while the screen is up', async () => {
    const realSetInterval = window.setInterval
    let tick: (() => void) | null = null
    window.setInterval = ((fn: () => void, ms: number) => {
      if (ms === ACCOUNT_COMPUTERS_REFRESH_MS) tick = fn
      return 1
    }) as unknown as typeof window.setInterval
    try {
      shell(CONNECTED, { cloud_devices: () => [ME, MAC] })
      render(<ServersScreen active onOpenSessions={() => {}} />)
      await screen.findByText('macOS · 3F9A 21C4')
      const before = ran('cloud_devices').length
      expect(tick).not.toBeNull()
      await act(async () => { tick?.() })
      await waitFor(() => expect(ran('cloud_devices').length).toBe(before + 1))
    } finally {
      window.setInterval = realSetInterval
    }
  })
})

describe('a computer whose LAN address stopped answering', () => {
  // The Mac turned "Allow devices on your network to connect" off: its saved
  // LAN address, still the app's server, no longer answers.
  it('is not In use, and a tap opens it again (LAN first, then the account) instead of the dead Sessions', async () => {
    window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
    dead.add(LAN)
    window.__OAD_API_BASE_URL__ = LAN
    const onOpenSessions = mock(() => {})
    const bridged = app({ base_url: BRIDGE, servers: [{ base_url: LAN, name: 'Studio Mac' }], account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } })
    shell(CONNECTED, {
      cloud_devices: () => [ME, MAC],
      cloud_open_computer: () => ({ status: bridged, via: 'account' }),
    }, app({ base_url: LAN, servers: [{ base_url: LAN, name: 'Studio Mac' }] }))
    const reload = mock(() => {})
    const realLocation = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: fakeLocation(realLocation, reload) })
    try {
      render(<ServersScreen active onOpenSessions={onOpenSessions} />)
      await screen.findByText('Home network or account')
    const row = rowOf('Studio Mac')
      await waitFor(() => expect(within(row).getByRole('button', { name: 'Use Studio Mac' })).toBeTruthy())
      expect(within(row).queryByText('In use')).toBeNull()

      fireEvent.click(within(row).getByRole('button', { name: 'Use Studio Mac' }))
      await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
      expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: LAN })
      expect(onOpenSessions).not.toHaveBeenCalled()
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
    }
  })

  it('is In use while its LAN address answers, and then goes to Sessions', async () => {
    window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
    window.__OAD_API_BASE_URL__ = LAN
    const onOpenSessions = mock(() => {})
    shell(CONNECTED, { cloud_devices: () => [ME, MAC] }, app({ base_url: LAN, servers: [{ base_url: LAN, name: 'Studio Mac' }] }))
    render(<ServersScreen active onOpenSessions={onOpenSessions} />)
    await screen.findByText('via LAN')
    const row = rowOf('Studio Mac')
    await waitFor(() => expect(within(row).getByText('In use')).toBeTruthy())
    fireEvent.click(within(row).getByRole('button', { name: 'Open sessions on Studio Mac' }))
    expect(onOpenSessions).toHaveBeenCalledTimes(1)
  })

  it('opens it again before any server answers, where there are no Sessions to go to', async () => {
    window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
    window.__OAD_API_BASE_URL__ = LAN
    shell(CONNECTED, {
      cloud_devices: () => [ME, MAC],
      cloud_open_computer: () => ({ status: app({ base_url: LAN, servers: [{ base_url: LAN, name: 'Studio Mac' }] }), via: 'lan' }),
    }, app({ base_url: LAN, servers: [{ base_url: LAN, name: 'Studio Mac' }] }))
    render(<ServersScreen active />)
    await screen.findByText('via LAN')
    const row = rowOf('Studio Mac')
    fireEvent.click(await within(row).findByRole('button', { name: 'Use Studio Mac' }))
    await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
  })
})

describe('the route in use, and the way back to the home network', () => {
  const BRIDGED = () => app({
    base_url: BRIDGE,
    servers: [{ base_url: LAN, name: 'Studio Mac' }],
    account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' },
  })
  const withLan = () => window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
  afterEach(() => { useAccountRouteStore.setState({ lanAvailable: {} }) })
  const computerRow = async (subtitle: string) => (await screen.findByText(subtitle)).closest('[data-server-row]') as HTMLElement

  it('says "Through your account" on the bridge, and offers Use home network beside Sessions', async () => {
    withLan()
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell(CONNECTED, { cloud_devices: () => [ME, MAC] }, BRIDGED())
    render(<ServersScreen active onOpenSessions={() => {}} />)
    const row = await computerRow('Through your account')
    expect(within(row).queryByText(/via LAN/)).toBeNull()
    expect(within(row).getByText('In use')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Use home network for Studio Mac' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Open sessions on Studio Mac' })).toBeTruthy()
  })

  it('has no home network button for a computer only the account reaches', async () => {
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell(CONNECTED, { cloud_devices: () => [ME, MAC] }, app({ base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }))
    render(<ServersScreen active onOpenSessions={() => {}} />)
    const row = await waitFor(() => rowOf('macOS · 3F9A 21C4'))
    await waitFor(() => expect(within(row).getByText('Through your account')).toBeTruthy())
    expect(within(row).queryByRole('button', { name: /Use home network/ })).toBeNull()
  })

  it('does not claim via LAN for a computer that is not in use', async () => {
    withLan()
    shell(CONNECTED, { cloud_devices: () => [ME, MAC] }, app({ servers: [{ base_url: NAS, name: 'Home NAS' }, { base_url: LAN, name: 'Studio Mac' }] }))
    render(<ServersScreen active onOpenSessions={() => {}} />)
    const row = await computerRow('Home network or account')
    expect(within(row).getByText('Home network or account')).toBeTruthy()
    expect(within(row).queryByText('via LAN')).toBeNull()
    expect(within(row).queryByRole('button', { name: /Use home network/ })).toBeNull()
  })

  it('says when the re-check found the home network but did not move', async () => {
    withLan()
    useAccountRouteStore.setState({ lanAvailable: { 'dev-mac': true } })
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell(CONNECTED, { cloud_devices: () => [ME, MAC] }, BRIDGED())
    render(<ServersScreen active onOpenSessions={() => {}} />)
    expect(await computerRow('Through your account · Home network available')).toBeTruthy()
  })

  it('switches to the home network with its saved address, and reloads onto it', async () => {
    withLan()
    useAccountRouteStore.setState({ lanAvailable: { 'dev-mac': true } })
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell(CONNECTED, {
      cloud_devices: () => [ME, MAC],
      cloud_open_computer: () => ({ status: app({ base_url: LAN, servers: [{ base_url: LAN, name: 'Studio Mac' }] }), via: 'lan' }),
    }, BRIDGED())
    const reload = mock(() => {})
    const realLocation = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: fakeLocation(realLocation, reload) })
    try {
      render(<ServersScreen active onOpenSessions={() => {}} />)
      const row = await computerRow('Through your account · Home network available')
      fireEvent.click(await within(row).findByRole('button', { name: 'Use home network for Studio Mac' }))
      await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
      expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: LAN })
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
      expect(useAccountRouteStore.getState().lanAvailable).toEqual({})
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
    }
  })

  it('shows the error when the switch fails, and stays put', async () => {
    withLan()
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell(CONNECTED, {
      cloud_devices: () => [ME, MAC],
      cloud_open_computer: () => { throw new Error('This computer is offline, or not signed in to your account.') },
    }, BRIDGED())
    render(<ServersScreen active onOpenSessions={() => {}} />)
    const row = await computerRow('Through your account')
    fireEvent.click(await within(row).findByRole('button', { name: 'Use home network for Studio Mac' }))
    expect((await screen.findByRole('alert')).textContent).toContain('This computer is offline')
  })

  it('says so when the shell kept the account (the home network lost the race)', async () => {
    withLan()
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell(CONNECTED, { cloud_devices: () => [ME, MAC], cloud_open_computer: () => ({ status: BRIDGED(), via: 'account' }) }, BRIDGED())
    render(<ServersScreen active onOpenSessions={() => {}} />)
    const row = await computerRow('Through your account')
    fireEvent.click(await within(row).findByRole('button', { name: 'Use home network for Studio Mac' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Still using your account')
  })

  it('offers the button on touch too, where the whole row opens it', async () => {
    withLan()
    window.__OAD_API_BASE_URL__ = BRIDGE
    const realMatchMedia = window.matchMedia
    window.matchMedia = (() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
    try {
      shell(CONNECTED, { cloud_devices: () => [ME, MAC] }, BRIDGED())
      render(<ServersScreen active onOpenSessions={() => {}} />)
      const row = await computerRow('Through your account')
      expect(await within(row).findByRole('button', { name: 'Use home network for Studio Mac' })).toBeTruthy()
      // Touch has no Sessions button: a tap on the row's name opens it.
      expect(within(row).queryByRole('button', { name: 'Open sessions on Studio Mac' })).toBeNull()
    } finally {
      window.matchMedia = realMatchMedia
    }
  })
})

describe('one QR scanner for both kinds of code', () => {
  const INVITE = 'agentd://invite?a=test-account-0000000000&s=test-slot-000000000&k=test-only'
  const INVITED: PhoneCloudStatus = { state: 'invited', fingerprint: 'AA11 BB22', kind: 'ios' }

  it('joins with a scanned invitation, shows the Joining step, and lands on the computers once added', async () => {
    scanned = INVITE
    shell(GUEST, {
      cloud_join_invite: () => { status = INVITED; return INVITED },
      cloud_devices: () => [ME, MAC],
    })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Use your computers from anywhere')
    fireEvent.click(screen.getAllByRole('button', { name: 'Scan QR code' })[0])

    await waitFor(() => expect(ran('cloud_join_invite')).toHaveLength(1))
    expect(ran('cloud_join_invite')[0].args).toEqual({ link: INVITE })
    const sheet = await screen.findByRole('dialog', { name: 'Account' })
    expect(within(sheet).getByText('Joining')).toBeTruthy()

    // The other device adds this phone.
    status = CONNECTED
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['phone-cloud', 'status'] }) })
    await waitFor(() => expect(screen.queryByText('Joining')).toBeNull())
    expect(await screen.findByText('macOS · 3F9A 21C4')).toBeTruthy()
    // Closing the sheet costs happy-dom a few busy seconds on a loaded machine.
  }, 15_000)

  it('fills the add-server form from a connect code, from either button', async () => {
    scanned = 'openagentd://connect?url=http%3A%2F%2F192.168.1.40%3A4082&key=k'
    shell(GUEST)
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Home NAS')
    fireEvent.click(screen.getAllByRole('button', { name: 'Scan QR code' })[1])
    expect(await screen.findByText('Scanned from another device. Check the server, then save and use it.')).toBeTruthy()
    expect(ran('cloud_join_invite')).toHaveLength(0)
  })

  it('joins with an invitation scanned under Your servers too', async () => {
    scanned = INVITE
    shell(GUEST, { cloud_join_invite: () => { status = INVITED; return INVITED } })
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Home NAS')
    fireEvent.click(screen.getAllByRole('button', { name: 'Scan QR code' })[1])
    await waitFor(() => expect(ran('cloud_join_invite')).toHaveLength(1))
  })

  it('names both kinds when the code is neither', async () => {
    scanned = 'https://example.com/not-a-code'
    shell(GUEST)
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Home NAS')
    fireEvent.click(screen.getAllByRole('button', { name: 'Scan QR code' })[0])
    expect((await screen.findByRole('alert')).textContent).toBe(NOT_A_CODE)
    expect(NOT_A_CODE).toContain('invitation')
    expect(NOT_A_CODE).toContain('connect code')
  })

  it('does not join a second account from a phone already in one', async () => {
    scanned = INVITE
    shell(CONNECTED)
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Home NAS')
    fireEvent.click(screen.getByRole('button', { name: 'Scan QR code' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already in an account')
    expect(ran('cloud_join_invite')).toHaveLength(0)
  })
})
