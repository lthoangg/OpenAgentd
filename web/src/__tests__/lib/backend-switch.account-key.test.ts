/**
 * An account computer's bridge key comes from the shell, and the shell may
 * hand out a new one for the same origin (a bridge that started again, the
 * desktop's built-in server after a restart). Every successful open reads it
 * again, past the page's caches, so requests carry the key the bridge holds
 * now, without a reload (fault 2 of the 3.53.1 brief).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

const BRIDGE = 'http://127.0.0.1:5999'
let onBridge = {
  base_url: BRIDGE,
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: false,
  servers: [],
  account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' },
}

/** The key the shell holds for the bridge now; null before it is open. */
let shellKey: string | null = null
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'cloud_open_computer') return { status: onBridge, via: 'account' }
    if (command === 'secure_get_access_key') return shellKey
    if (command === 'app_backend_status') return onBridge
    return null
  },
}))

const { primeStoredAccessKey } = await import('@/api/auth')
const { connectAccountComputer } = await import('@/lib/backend-switch')

let sent: Array<string | null> = []
const originalFetch = window.fetch

/** What a page request to the bridge carries. */
async function requestKey(origin: string = BRIDGE): Promise<string | null> {
  sent = []
  await window.fetch(`${origin}/api/health`)
  return sent[0] ?? null
}

const open = () => connectAccountComputer({ deviceId: 'dev-mac', label: 'Mac', currentBaseUrl: BRIDGE })

beforeEach(() => {
  window.__OAD_API_BASE_URL__ = BRIDGE
  window.localStorage.clear()
  // The page's own fetch, under the auth interceptor once it installs.
  const fake = mock(async (...args: unknown[]) => {
    const init = args[1] as RequestInit | undefined
    sent.push(new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? null)
    return new Response('{}', { status: 200 })
  })
  if (window.fetch === originalFetch) {
    window.fetch = fake as unknown as typeof window.fetch
    globalThis.fetch = window.fetch
  }
})

afterEach(() => {
  delete window.__OAD_API_BASE_URL__
})

describe('an account computer\u2019s key', () => {
  it('follows the shell when the same origin gets a new key, with no reload', async () => {
    shellKey = 'K1'
    const first = await open()
    expect(first).toMatchObject({ ok: true, reload: false })
    expect(await requestKey()).toBe('K1')
    // The bridge started again under the same origin, with a new key.
    shellKey = 'K2'
    const second = await open()
    expect(second).toMatchObject({ ok: true, reload: false })
    expect(await requestKey()).toBe('K2')
  })

  it('is read when the bridge opens, though the launch found none for that origin', async () => {
    const remembered = 'http://127.0.0.1:6111'
    onBridge = { ...onBridge, base_url: remembered }
    window.__OAD_API_BASE_URL__ = remembered
    // Cold launch: the remembered origin is a bridge that is not open yet.
    shellKey = null
    await primeStoredAccessKey(remembered)
    // Then that bridge opens, on the origin the page is on: no reload.
    shellKey = 'K3'
    const result = await connectAccountComputer({ deviceId: 'dev-mac', label: 'Mac', currentBaseUrl: remembered })
    expect(result).toMatchObject({ ok: true, reload: false })
    expect(await requestKey(remembered)).toBe('K3')
  })
})
