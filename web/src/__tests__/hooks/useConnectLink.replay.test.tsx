/**
 * The deep-link plugin reports the last link the app was opened with for the
 * life of the app, so a reloaded page reads a scanned connect link again. One
 * this app run already showed is not shown twice; the same QR code scanned
 * again while the page could not listen (iOS ended it in the background) is
 * a new scan, which the phone shell's link count tells apart.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => ({ isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }) }))

/** What the plugin reports as the link the app was last opened with. */
let lastOpened: string[] = []
const getCurrent = mock(() => Promise.resolve(lastOpened))
let openUrl: ((urls: string[]) => void) | null = null
mock.module('@tauri-apps/plugin-deep-link', () => ({
  getCurrent,
  onOpenUrl: async (cb: (urls: string[]) => void) => {
    openUrl = cb
    return () => { openUrl = null }
  },
}))
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
/** Links the shell has seen arrive this app run; null: a shell without the count. */
let linksOpened: number | null = 1
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'deep_link_sequence' && linksOpened !== null) return linksOpened
    // On another server than the scanned one.
    if (command === 'app_backend_status') return { base_url: 'http://10.0.0.9:4082', external: true, sidecar_running: false, supports_bundled: false, servers: [] }
    throw new Error(`unexpected command: ${command}`)
  },
}))

const { useConnectLink } = await import('@/hooks/useConnectLink')
const { buildConnectLink } = await import('@/lib/connect-link')

const KEY = 'generated-key-0123456789abcdef' // gitleaks:allow (synthetic)
const SERVER = 'http://192.168.1.20:4082'
const QR_LINK = buildConnectLink({ urls: [SERVER], key: KEY })
const originalFetch = globalThis.fetch

let latest: ReturnType<typeof useConnectLink> | null = null
function Probe() {
  latest = useConnectLink()
  return null
}

/** A page load: the hook mounts and reads the link the app was last opened with. */
async function loadPage() {
  latest = null
  getCurrent.mockClear()
  render(<Probe />)
  await waitFor(() => expect(getCurrent).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 20))
}

beforeEach(() => {
  linksOpened = 1
  lastOpened = [QR_LINK]
  openUrl = null
  localStorage.clear()
  sessionStorage.clear()
  globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('a scanned connect link, read again by a reloaded page', () => {
  it('is not shown twice', async () => {
    await loadPage()
    expect(latest?.request).toEqual({ baseUrl: SERVER, accessKey: KEY })
    cleanup()
    await loadPage()
    expect(latest?.request).toBeNull()
  })

  it('is shown when the same QR code was scanned again while no page was listening', async () => {
    await loadPage()
    expect(latest?.request).not.toBeNull()
    cleanup()
    // Scanned again from the camera: the shell counted another link.
    linksOpened = 2
    await loadPage()
    expect(latest?.request).toEqual({ baseUrl: SERVER, accessKey: KEY })
    // And that scan is not shown a third time by the next reload.
    cleanup()
    await loadPage()
    expect(latest?.request).toBeNull()
  })

  it('is not shown again after it arrived while the page was listening', async () => {
    lastOpened = []
    await loadPage()
    linksOpened = 2
    lastOpened = [QR_LINK]
    await act(async () => openUrl?.([QR_LINK]))
    await waitFor(() => expect(latest?.request).not.toBeNull())
    cleanup()
    await loadPage()
    expect(latest?.request).toBeNull()
  })

  it('is told apart by the link alone on a shell without the count', async () => {
    linksOpened = null
    await loadPage()
    expect(latest?.request).not.toBeNull()
    cleanup()
    await loadPage()
    expect(latest?.request).toBeNull()
  })
})
