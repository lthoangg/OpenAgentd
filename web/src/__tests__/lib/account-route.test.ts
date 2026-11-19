/**
 * The phone and its account computers: at launch the computer last opened
 * is opened again (through its link, never a saved address), and resume,
 * background and network changes reach the shell as `cloud_poke`. A saved
 * server is a separate thing: nothing here moves between it and an account
 * computer.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { waitFor } from '@testing-library/react'

/** A plain stand-in for window.location whose reload is a mock. */
function fakeLocation(real: Location, reload: () => void): Location {
  const { href, origin, protocol, host, hostname, port, pathname, search, hash } = real
  return { href, origin, protocol, host, hostname, port, pathname, search, hash, reload, assign: () => {}, replace: () => {} } as unknown as Location
}

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
const desktop = { isTauri: true, os: 'macos', isMacOverlay: false, isFullscreen: false }
let platform = phone
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => platform, usePlatform: () => platform }))

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

const { checkRouteAtLaunch, resetAccountRoute, startAccountRouteWatch } = await import('@/lib/account-route')
const { openSessionOnServer } = await import('@/lib/open-on-server')
const { takePendingSessionOpen } = await import('@/lib/pending-session-open')
const { resetPageUnloading } = await import('@/lib/page-unload')
const { reloadForBackendSwitch } = await import('@/lib/backend-switch')
const { noteBackendStatus } = await import('@/lib/app-backend')
const { lastRouteStorageKey } = await import('@/lib/route-restore')
const { queryClient } = await import('@/lib/query-client')
const { queryKeys } = await import('@/queries/keys')
const { useServersScreenStore } = await import('@/stores/useServersScreenStore')
const { beginBackendSwitch, useBackendSwitchStore } = await import('@/stores/useBackendSwitchStore')

const LAN = 'http://192.168.1.20:4082'
const BRIDGE = 'http://127.0.0.1:5999'
const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true }
const LINUX = { device_id: 'dev-linux', fingerprint: '9C02 E1B7', signer: false, me: false, kind: 'linux', server: true, client: false }
const ME = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true }
const SERVERS = [{ base_url: LAN, name: 'Studio Mac' }]
const onLan = { base_url: LAN, mode: 'external', sidecar_running: false, external: true, supports_bundled: false, servers: SERVERS }
const onBridge = { ...onLan, base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }
const onLinuxBridge = { ...onLan, base_url: 'http://127.0.0.1:6002', account_device: { device_id: 'dev-linux', fingerprint: '9C02 E1B7', kind: 'linux' } }

let probes: string[] = []
const originalFetch = globalThis.fetch
const realLocation = window.location
let reload = mock(() => {})

function shell(extra: Record<string, Handler> = {}) {
  handlers = {
    app_backend_status: () => onLan,
    cloud_status: () => ({ state: 'connected', fingerprint: 'AA11 BB22', signer: true }),
    cloud_devices: () => [ME, MAC],
    cloud_open_computer: () => ({ status: onBridge, via: 'account' }),
    cloud_poke: () => null,
    secure_get_access_key: () => null,
    ...extra,
  }
}

const ran = (command: string) => calls.filter((call) => call.command === command)

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
}
function restoreVisibility() {
  delete (document as unknown as Record<string, unknown>).visibilityState
}

beforeEach(() => {
  calls = []
  probes = []
  platform = phone
  resetAccountRoute()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.__OAD_API_BASE_URL__ = LAN
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    probes.push(url)
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  reload = mock(() => {})
  Object.defineProperty(window, 'location', { configurable: true, value: fakeLocation(realLocation, reload) })
  useServersScreenStore.setState({ request: 0, prefill: null })
  useBackendSwitchStore.setState({ target: null, generation: 0, committing: false })
  shell()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  delete window.__OAD_API_BASE_URL__
})

describe('at launch', () => {
  it('opens the computer last opened through its link, never a saved address, and reloads onto it', async () => {
    shell({ app_backend_status: () => ({ ...onLan, last_account_device: 'dev-mac' }) })
    expect(await checkRouteAtLaunch()).toBe('switched')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: null })
    expect(reload).toHaveBeenCalledTimes(1)
    // Nothing was sent to, or asked of, the saved server's address.
    expect(probes.filter((url) => url.startsWith(LAN))).toEqual([])
  })

  it('opens it too on a phone with no saved server (nothing to be on yet)', async () => {
    shell({ app_backend_status: () => ({ ...onLan, base_url: '', servers: [], last_account_device: 'dev-mac' }) })
    expect(await checkRouteAtLaunch()).toBe('switched')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the app is already on that computer', async () => {
    shell({ app_backend_status: () => ({ ...onBridge, last_account_device: 'dev-mac' }) })
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })

  it('leaves a saved server alone when no account computer was last used', async () => {
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
    expect(ran('cloud_devices')).toHaveLength(0)
  })

  it('shows the Servers screen when the computer cannot be opened', async () => {
    shell({
      app_backend_status: () => ({ ...onLan, base_url: BRIDGE, last_account_device: 'dev-mac', account_device: undefined }),
      cloud_open_computer: () => { throw new Error('This computer is offline, or not signed in to your account.') },
    })
    expect(await checkRouteAtLaunch()).toBe('failed')
    expect(useServersScreenStore.getState().request).toBe(1)
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(1)
  })

  it('skips a computer no longer in the account', async () => {
    shell({ app_backend_status: () => ({ ...onLan, last_account_device: 'dev-gone' }) })
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })

  // A notification from another computer launched the app: its tap picks the computer.
  const noServerYet = () => ({ ...onLan, base_url: '', servers: [], last_account_device: 'dev-mac' })

  it('leaves the choice to a switch already under way', async () => {
    shell({ app_backend_status: noServerYet })
    beginBackendSwitch({ name: 'Linux box' })
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
    expect(reload).not.toHaveBeenCalled()
  })

  it('gives way without a word to a switch that starts while it opens the last computer', async () => {
    let opened: (value: unknown) => void = () => {}
    shell({
      app_backend_status: noServerYet,
      cloud_open_computer: () => new Promise((resolve) => { opened = resolve }),
    })
    const launch = checkRouteAtLaunch()
    await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
    beginBackendSwitch({ name: 'Linux box' })
    opened({ status: onBridge, via: 'account' })
    expect(await launch).toBe('skipped')
    // Not a failure: no Servers screen over the switch that replaced it, and no reload of its own.
    expect(useServersScreenStore.getState().request).toBe(0)
    expect(reload).not.toHaveBeenCalled()
  })

  /** What the page after the reload opens (this one, reloading, takes nothing). */
  function sessionForReloadedPage(): string | null {
    resetPageUnloading()
    return takePendingSessionOpen()
  }

  /** A shell whose answer to the tap's device list waits for `listDevices`; the launch's own is answered at once. */
  function shellWithTapWaitingForDevices(tapAsksFirst: boolean, extra: Record<string, Handler> = {}) {
    let asked = 0
    let listDevices: () => void = () => {}
    const held = new Promise<unknown>((resolve) => { listDevices = () => resolve([ME, MAC, LINUX]) })
    shell({
      app_backend_status: noServerYet,
      cloud_devices: () => ((asked++ === 0) === tapAsksFirst ? held : [ME, MAC, LINUX]),
      cloud_open_computer: (args) => ({ status: args?.deviceId === 'dev-linux' ? onLinuxBridge : onBridge, via: 'account' }),
      ...extra,
    })
    return () => listDevices()
  }

  it('leaves the choice to a tapped notification that is on its way to another computer', async () => {
    const listDevices = shellWithTapWaitingForDevices(true)
    const tap = openSessionOnServer({ sessionId: 's-linux', deviceId: 'dev-linux' })
    await waitFor(() => expect(ran('cloud_devices')).toHaveLength(1))
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
    listDevices()
    expect(await tap).toBe('switching')
    expect(ran('cloud_open_computer').map((call) => call.args?.deviceId)).toEqual(['dev-linux'])
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionForReloadedPage()).toBe('s-linux')
  })

  it('does not reload under a tap that arrived while it opened the last computer', async () => {
    let opened: () => void = () => {}
    const lastOpened = new Promise<unknown>((resolve) => { opened = () => resolve({ status: onBridge, via: 'account' }) })
    const listDevices = shellWithTapWaitingForDevices(false, {
      cloud_open_computer: (args) => (args?.deviceId === 'dev-mac' ? lastOpened : { status: onLinuxBridge, via: 'account' }),
    })
    const launch = checkRouteAtLaunch()
    await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
    const tap = openSessionOnServer({ sessionId: 's-linux', deviceId: 'dev-linux' })
    await waitFor(() => expect(ran('cloud_devices')).toHaveLength(2))
    opened()
    // The last computer is open. A reload now would end the page with the
    // tap already read from the shell's queue: the launch waits for the tap.
    await waitFor(() => expect(ran('secure_get_access_key').length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reload).not.toHaveBeenCalled()
    listDevices()
    expect(await tap).toBe('switching')
    expect(await launch).toBe('skipped')
    expect(ran('cloud_open_computer').map((call) => call.args?.deviceId)).toEqual(['dev-mac', 'dev-linux'])
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionForReloadedPage()).toBe('s-linux')
  })

  it('reloads onto the last computer once a tap for that same computer has asked for its session', async () => {
    let opened: () => void = () => {}
    const lastOpened = new Promise<unknown>((resolve) => { opened = () => resolve({ status: onBridge, via: 'account' }) })
    // The shell's status: on no server, then (asked by the tap) on the last computer.
    let status: unknown = noServerYet()
    shell({ app_backend_status: () => status, cloud_open_computer: () => lastOpened })
    const launch = checkRouteAtLaunch()
    await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
    let answerTap: () => void = () => {}
    status = new Promise((resolve) => { answerTap = () => resolve({ ...onBridge, last_account_device: 'dev-mac' }) })
    opened()
    const tap = openSessionOnServer({ sessionId: 's-mac', deviceId: 'dev-mac' })
    await waitFor(() => expect(ran('secure_get_access_key').length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reload).not.toHaveBeenCalled()
    answerTap()
    // Already on its computer: the tap switches nothing, so the launch's reload still has to happen.
    expect(await tap).toBe('opened')
    expect(await launch).toBe('switched')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionForReloadedPage()).toBe('s-mac')
  })
})

describe('telling the shell', () => {
  const pokes = () => ran('cloud_poke').map((call) => call.args)
  let stop = () => {}
  afterEach(() => stop())

  it('pokes on resume, going to the background, and a network change; nothing else runs', async () => {
    stop = startAccountRouteWatch()
    await new Promise((resolve) => setTimeout(resolve, 20))
    calls = []
    try {
      setVisibility('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      setVisibility('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('online'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      restoreVisibility()
    }
    expect(pokes()).toEqual([{ why: 'background' }, { why: 'resumed' }, { why: 'network_changed' }])
    // The link moves between routes by itself: no switch, no probe, no reload.
    expect(ran('cloud_open_computer')).toHaveLength(0)
    expect(probes).toEqual([])
    expect(reload).not.toHaveBeenCalled()
  })

  it('ignores a shell without cloud_poke', async () => {
    delete handlers.cloud_poke
    stop = startAccountRouteWatch()
    window.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The one at start (the page is visible), and the network change.
    expect(ran('cloud_poke')).toHaveLength(2)
  })

  it('does nothing off the phone, and stops listening when stopped', async () => {
    platform = desktop
    stop = startAccountRouteWatch()
    window.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ran('cloud_poke')).toHaveLength(0)
    platform = phone
    setVisibility('hidden')
    try {
      stop = startAccountRouteWatch()
      stop()
      window.dispatchEvent(new Event('online'))
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      restoreVisibility()
    }
    expect(ran('cloud_poke')).toHaveLength(0)
  })

  it('pokes resumed once when the page starts visible, so a reload never leaves the links in the background', async () => {
    setVisibility('visible')
    try {
      stop = startAccountRouteWatch()
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      restoreVisibility()
    }
    expect(pokes()).toEqual([{ why: 'resumed' }])
  })

  it('does not poke background for the visibilitychange of its own reload onto another server', async () => {
    stop = startAccountRouteWatch()
    await new Promise((resolve) => setTimeout(resolve, 20))
    calls = []
    reloadForBackendSwitch()
    expect(reload).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      restoreVisibility()
    }
    expect(pokes()).toEqual([])
  })

  it('reloads onto the bridge when the shell moved it while the app was away', async () => {
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell({ app_backend_status: () => ({ ...onBridge, base_url: 'http://127.0.0.1:6001' }) })
    stop = startAccountRouteWatch()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the place when the same computer only moved to another port', async () => {
    // The page started on this computer's bridge and is in one of its sessions.
    window.__OAD_API_BASE_URL__ = BRIDGE
    noteBackendStatus(onBridge)
    window.localStorage.setItem(lastRouteStorageKey(), '/s-mac')
    shell({ app_backend_status: () => ({ ...onBridge, base_url: 'http://127.0.0.1:6001' }) })
    stop = startAccountRouteWatch()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    // The sessions are the same ones: the reload returns to where the person was.
    expect(window.localStorage.getItem(lastRouteStorageKey())).toBe('/s-mac')
  })

  it('forgets the place when the shell is on another computer by then', async () => {
    window.__OAD_API_BASE_URL__ = BRIDGE
    noteBackendStatus(onBridge)
    window.localStorage.setItem(lastRouteStorageKey(), '/s-mac')
    shell({ app_backend_status: () => onLinuxBridge })
    stop = startAccountRouteWatch()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(window.localStorage.getItem(lastRouteStorageKey())).toBeNull()
  })

  it('on an account computer, a failed health check pokes user_retry once and checks again', async () => {
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell({ app_backend_status: () => onBridge })
    stop = startAccountRouteWatch()
    await new Promise((resolve) => setTimeout(resolve, 20))
    calls = []
    const failing = async () => {
      throw new Error('link_down')
    }
    try {
      await queryClient.fetchQuery({ queryKey: queryKeys.health(), queryFn: failing, retry: false, staleTime: 0 }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 30))
      // The check that follows fails too: still one poke for this failure.
      await queryClient.fetchQuery({ queryKey: queryKeys.health(), queryFn: failing, retry: false, staleTime: 0 }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(pokes()).toEqual([{ why: 'user_retry' }])
      // Once it answers, the next failure gets its own poke.
      await queryClient.fetchQuery({ queryKey: queryKeys.health(), queryFn: async () => ({ status: 'ok' }), retry: false, staleTime: 0 })
      await queryClient.fetchQuery({ queryKey: queryKeys.health(), queryFn: failing, retry: false, staleTime: 0 }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(pokes()).toEqual([{ why: 'user_retry' }, { why: 'user_retry' }])
    } finally {
      queryClient.removeQueries({ queryKey: queryKeys.health() })
    }
  })

  it('off an account computer, a failed health check pokes nothing', async () => {
    stop = startAccountRouteWatch()
    await new Promise((resolve) => setTimeout(resolve, 20))
    calls = []
    await queryClient.fetchQuery({ queryKey: queryKeys.health(), queryFn: async () => { throw new Error('down') }, retry: false }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pokes()).toEqual([])
    queryClient.removeQueries({ queryKey: queryKeys.health() })
  })
})
