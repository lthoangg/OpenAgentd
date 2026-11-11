/**
 * The phone's route to an account computer: the launch check (the computer
 * last opened, or the older LAN-address fallback), the re-check on resume and
 * network change (two failed checks leave a LAN address; a working home
 * network is taken only when no reply runs and the composer is empty, else
 * offered), one re-check at a time, and the `cloud_poke` events.
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

const { checkRouteAtLaunch, recheckAccountRoute, resetAccountRoute, startAccountRouteWatch } = await import('@/lib/account-route')
const { useServersScreenStore } = await import('@/stores/useServersScreenStore')
const { useAccountRouteStore } = await import('@/stores/useAccountRouteStore')
const { useAgentStore } = await import('@/stores/useAgentStore')

const LAN = 'http://192.168.1.20:4082'
const BRIDGE = 'http://127.0.0.1:5999'
const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true }
const ME = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true }
const SERVERS = [{ base_url: LAN, name: 'Studio Mac' }]
const onLan = { base_url: LAN, mode: 'external', sidecar_running: false, external: true, supports_bundled: false, servers: SERVERS }
const onBridge = { ...onLan, base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }

/** What the saved LAN address does: does it answer, and does it take the stored key. */
let lan = { ping: true, key: true }
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

/** Pings of the LAN address so far. */
const pings = () => probes.filter((url) => url === `${LAN}/api/health/live`).length
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
  lan = { ping: true, key: true }
  platform = phone
  resetAccountRoute()
  window.localStorage.clear()
  window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
  window.__OAD_API_BASE_URL__ = LAN
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    probes.push(url)
    if (url.startsWith(LAN)) {
      if (url.endsWith('/api/health/live') && !lan.ping) throw new TypeError('Load failed')
      if (url.endsWith('/api/auth/check')) return new Response(null, { status: lan.key ? 204 : 401 })
    }
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  reload = mock(() => {})
  Object.defineProperty(window, 'location', { configurable: true, value: fakeLocation(realLocation, reload) })
  useServersScreenStore.setState({ request: 0, prefill: null })
  useAccountRouteStore.setState({ lanAvailable: {} })
  useAgentStore.setState({ isAgentWorking: false, _pendingMessages: [] })
  shell()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  delete window.__OAD_API_BASE_URL__
})

describe('at launch', () => {
  it('opens the computer last opened, with its saved LAN address, and reloads onto it', async () => {
    shell({ app_backend_status: () => ({ ...onLan, last_account_device: 'dev-mac', base_url: BRIDGE, account_device: { device_id: 'dev-other', fingerprint: 'F00D 0001', kind: 'linux' } }), cloud_open_computer: () => ({ status: onLan, via: 'lan' }) })
    expect(await checkRouteAtLaunch()).toBe('switched')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: LAN })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('opens it through the account (no LAN address) when none is saved for it', async () => {
    window.localStorage.clear()
    shell({ app_backend_status: () => ({ ...onLan, last_account_device: 'dev-mac' }) })
    expect(await checkRouteAtLaunch()).toBe('switched')
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: null })
  })

  it('does nothing when the app is already on that computer\'s bridge, or on its LAN address that answers', async () => {
    shell({ app_backend_status: () => ({ ...onBridge, last_account_device: 'dev-mac' }) })
    expect(await checkRouteAtLaunch()).toBe('skipped')
    resetAccountRoute()
    shell({ app_backend_status: () => ({ ...onLan, last_account_device: 'dev-mac' }) })
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
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

  it('without last_account_device, opens a LAN address that does not answer through the account', async () => {
    lan = { ping: false, key: true }
    expect(await checkRouteAtLaunch()).toBe('switched')
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: null })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('without last_account_device, leaves a LAN address that answers, and a server that is no account computer', async () => {
    expect(await checkRouteAtLaunch()).toBe('skipped')
    resetAccountRoute()
    lan = { ping: false, key: true }
    window.localStorage.clear()
    expect(await checkRouteAtLaunch()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })
})

describe('on a LAN address of an account computer', () => {
  it('moves to the account after two failed checks in a row', async () => {
    lan = { ping: false, key: true }
    expect(await recheckAccountRoute('resumed', { recheckDelayMs: 0 })).toBe('switched')
    expect(pings()).toBe(2)
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: null })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('counts a refused key as a failed check, too', async () => {
    lan = { ping: true, key: false }
    expect(await recheckAccountRoute('network_changed', { recheckDelayMs: 0 })).toBe('switched')
    expect(ran('cloud_open_computer')).toHaveLength(1)
  })

  it('stays when it answers at once, or answers on the second check', async () => {
    expect(await recheckAccountRoute('resumed', { recheckDelayMs: 0 })).toBe('skipped')
    expect(pings()).toBe(1)
    // First check fails; the address is back by the second.
    lan = { ping: false, key: true }
    let seen = 0
    handlers.app_backend_status = () => {
      seen += 1
      if (seen === 2) lan = { ping: true, key: true }
      return onLan
    }
    expect(await recheckAccountRoute('resumed', { recheckDelayMs: 0 })).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })

  it('does nothing for a server that is no account computer, or while the app is in the background', async () => {
    lan = { ping: false, key: true }
    window.localStorage.clear()
    expect(await recheckAccountRoute('resumed', { recheckDelayMs: 0 })).toBe('skipped')
    window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
    setVisibility('hidden')
    try {
      expect(await recheckAccountRoute('network_changed', { recheckDelayMs: 0 })).toBe('skipped')
    } finally {
      restoreVisibility()
    }
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })

  it('runs one re-check at a time', async () => {
    lan = { ping: false, key: true }
    const [first, second] = await Promise.all([
      recheckAccountRoute('resumed', { recheckDelayMs: 5 }),
      recheckAccountRoute('network_changed', { recheckDelayMs: 5 }),
    ])
    expect(first).toBe('switched')
    expect(second).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(pings()).toBe(2)
  })
})

describe('on an account bridge whose computer has a saved LAN address', () => {
  beforeEach(() => {
    window.__OAD_API_BASE_URL__ = BRIDGE
    shell({ app_backend_status: () => onBridge, cloud_open_computer: () => ({ status: onLan, via: 'lan' }) })
  })

  it('moves back to the LAN when it answers and accepts the key, and nothing is in the way', async () => {
    expect(await recheckAccountRoute('network_changed')).toBe('switched')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: LAN })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(useAccountRouteStore.getState().lanAvailable).toEqual({})
  })

  it('stays on the account while the LAN does not answer, or refuses the stored key', async () => {
    lan = { ping: false, key: true }
    expect(await recheckAccountRoute('resumed')).toBe('skipped')
    lan = { ping: true, key: false }
    expect(await recheckAccountRoute('resumed')).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
    expect(useAccountRouteStore.getState().lanAvailable).toEqual({})
  })

  it('only offers it while a reply is running', async () => {
    useAgentStore.setState({ isAgentWorking: true })
    expect(await recheckAccountRoute('resumed')).toBe('offered')
    expect(ran('cloud_open_computer')).toHaveLength(0)
    expect(reload).not.toHaveBeenCalled()
    expect(useAccountRouteStore.getState().lanAvailable).toEqual({ 'dev-mac': true })
  })

  it('only offers it while the composer holds text', async () => {
    window.localStorage.setItem('oa.drafts.composer.v1', JSON.stringify([['session-1', { value: 'half a thought' }]]))
    expect(await recheckAccountRoute('resumed')).toBe('offered')
    expect(ran('cloud_open_computer')).toHaveLength(0)
    expect(useAccountRouteStore.getState().lanAvailable).toEqual({ 'dev-mac': true })
  })

  it('takes back the offer once the LAN stops answering', async () => {
    useAgentStore.setState({ isAgentWorking: true })
    await recheckAccountRoute('resumed')
    lan = { ping: false, key: true }
    expect(await recheckAccountRoute('network_changed')).toBe('skipped')
    expect(useAccountRouteStore.getState().lanAvailable).toEqual({})
  })

  it('has no LAN to go to when the computer has no saved server', async () => {
    window.localStorage.clear()
    expect(await recheckAccountRoute('resumed')).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })
})

describe('telling the shell', () => {
  const pokes = () => ran('cloud_poke').map((call) => call.args)
  let stop = () => {}
  afterEach(() => stop())

  it('pokes on resume, going to the background, and a network change', async () => {
    stop = startAccountRouteWatch()
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
  })

  it('ignores a shell without cloud_poke', async () => {
    delete handlers.cloud_poke
    stop = startAccountRouteWatch()
    window.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ran('cloud_poke')).toHaveLength(1)
  })

  it('does nothing off the phone, and stops listening when stopped', async () => {
    platform = desktop
    stop = startAccountRouteWatch()
    window.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ran('cloud_poke')).toHaveLength(0)
    platform = phone
    stop = startAccountRouteWatch()
    stop()
    window.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ran('cloud_poke')).toHaveLength(0)
  })
})
