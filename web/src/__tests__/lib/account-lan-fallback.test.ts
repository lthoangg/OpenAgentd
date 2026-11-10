/**
 * The launch fallback: a saved LAN server that is an account computer and
 * does not answer is opened through the account, once per launch.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

/** A plain stand-in for window.location whose reload is a mock. */
function fakeLocation(real: Location, reload: () => void): Location {
  const { href, origin, protocol, host, hostname, port, pathname, search, hash } = real
  return { href, origin, protocol, host, hostname, port, pathname, search, hash, reload, assign: () => {}, replace: () => {} } as unknown as Location
}

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

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

const { fallBackToAccountOnce, resetAccountLanFallback } = await import('@/lib/account-lan-fallback')
const { useServersScreenStore } = await import('@/stores/useServersScreenStore')

const LAN = 'http://192.168.1.20:4082'
const BRIDGE = 'http://127.0.0.1:5999'
const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true }
const ME = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true }
const onLan = { base_url: LAN, sidecar_running: false, external: true, supports_bundled: false, servers: [{ base_url: LAN, name: 'Studio Mac' }] }
const onBridge = { ...onLan, base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }

let lanAnswers = false
const originalFetch = globalThis.fetch
const realLocation = window.location
let reload = mock(() => {})

function shell(extra: Record<string, Handler> = {}) {
  handlers = {
    app_backend_status: () => onLan,
    cloud_status: () => ({ state: 'connected', fingerprint: 'AA11 BB22', signer: true }),
    cloud_devices: () => [ME, MAC],
    cloud_open_computer: () => ({ status: onBridge, via: 'account' }),
    secure_get_access_key: () => null,
    ...extra,
  }
}

beforeEach(() => {
  calls = []
  lanAnswers = false
  resetAccountLanFallback()
  window.localStorage.clear()
  window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
  window.__OAD_API_BASE_URL__ = LAN
  globalThis.fetch = mock(async (input: unknown) => {
    if (String(input).startsWith(LAN) && !lanAnswers) throw new TypeError('Load failed')
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

const ran = (command: string) => calls.filter((call) => call.command === command)

describe('fallBackToAccountOnce', () => {
  it('opens the computer through the account when its LAN address does not answer', async () => {
    expect(await fallBackToAccountOnce()).toBe('switched')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: null })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('tries once per launch, and shows the Servers screen when it fails', async () => {
    shell({ cloud_open_computer: () => { throw new Error('This computer is offline, or not signed in to your account.') } })
    expect(await fallBackToAccountOnce()).toBe('failed')
    expect(useServersScreenStore.getState().request).toBe(1)
    expect(await fallBackToAccountOnce()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('leaves a LAN address that answers alone', async () => {
    lanAnswers = true
    expect(await fallBackToAccountOnce()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })

  it('does nothing for a server that is not an account computer', async () => {
    window.localStorage.clear()
    expect(await fallBackToAccountOnce()).toBe('skipped')
    expect(ran('cloud_devices')).toHaveLength(0)
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })

  it('does nothing when the phone is not signed in, or already on the account bridge', async () => {
    shell({ cloud_status: () => ({ state: 'signing_in', user_code: 'X', url: 'https://a', fingerprint: 'f', expires_in: 1 }) })
    expect(await fallBackToAccountOnce()).toBe('skipped')
    resetAccountLanFallback()
    shell({ app_backend_status: () => onBridge })
    expect(await fallBackToAccountOnce()).toBe('skipped')
    expect(ran('cloud_open_computer')).toHaveLength(0)
  })
})
