/**
 * The phone and its account computers: at launch the computer last opened
 * is opened again (through its link, never a saved address), and resume,
 * background and network changes reach the shell as `cloud_poke`. A saved
 * server is a separate thing: nothing here moves between it and an account
 * computer.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

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
const { reloadForBackendSwitch } = await import('@/lib/backend-switch')
const { queryClient } = await import('@/lib/query-client')
const { queryKeys } = await import('@/queries/keys')
const { useServersScreenStore } = await import('@/stores/useServersScreenStore')

const LAN = 'http://192.168.1.20:4082'
const BRIDGE = 'http://127.0.0.1:5999'
const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true }
const ME = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true }
const SERVERS = [{ base_url: LAN, name: 'Studio Mac' }]
const onLan = { base_url: LAN, mode: 'external', sidecar_running: false, external: true, supports_bundled: false, servers: SERVERS }
const onBridge = { ...onLan, base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }

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
  window.__OAD_API_BASE_URL__ = LAN
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    probes.push(url)
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  reload = mock(() => {})
  Object.defineProperty(window, 'location', { configurable: true, value: fakeLocation(realLocation, reload) })
  useServersScreenStore.setState({ request: 0, prefill: null })
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
