import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useConnectLink } from '@/hooks/useConnectLink'
import { buildConnectLink } from '@/lib/connect-link'

const getCurrent = mock(() => Promise.resolve([] as string[] | null))
const onOpenUrl = mock((_handler: unknown) => Promise.resolve(() => {}))
let currentWindowLabel = 'main'
let online = new Set<string>()
/** Server the shell reports as connected (`app_backend_status`); null = none. */
let activeBaseUrl: string | null = null

mock.module('@tauri-apps/plugin-deep-link', () => ({ getCurrent, onOpenUrl }))
mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: currentWindowLabel }),
}))
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command !== 'app_backend_status') throw new Error(`unexpected command ${command}`)
    return { base_url: activeBaseUrl ?? '', external: true, sidecar_running: false, supports_bundled: false, servers: [] }
  },
}))

const KEY = 'generated-key-0123456789abcdef'
let latest: ReturnType<typeof useConnectLink> | null = null

function Probe() {
  latest = useConnectLink()
  return null
}

beforeEach(() => {
  latest = null
  currentWindowLabel = 'main'
  online = new Set()
  activeBaseUrl = null
  window.sessionStorage.clear()
  window.localStorage.clear()
  getCurrent.mockReset()
  getCurrent.mockImplementation(() => Promise.resolve([]))
  onOpenUrl.mockReset()
  onOpenUrl.mockImplementation(() => Promise.resolve(() => {}))
  globalThis.fetch = mock(async (input: unknown) => {
    const origin = new URL(String(input)).origin
    return new Response(null, { status: online.has(origin) ? 200 : 503 })
  }) as unknown as typeof fetch
})

afterEach(() => cleanup())

describe('useConnectLink', () => {
  it('turns a cold-start connect link into a request', async () => {
    online.add('http://192.168.1.20:4082')
    getCurrent.mockImplementation(() => Promise.resolve([buildConnectLink({ urls: ['http://192.168.1.20:4082'], key: KEY })]))
    render(<Probe />)
    await waitFor(() => expect(latest?.request).toEqual({ baseUrl: 'http://192.168.1.20:4082', accessKey: KEY }))
  })

  it('picks the first reachable address from a warm link', async () => {
    online.add('http://10.0.0.5:4082')
    let openUrls: ((urls: string[]) => void) | undefined
    onOpenUrl.mockImplementation(async (handler) => {
      openUrls = handler as (urls: string[]) => void
      return () => {}
    })
    render(<Probe />)
    await waitFor(() => expect(openUrls).toBeDefined())

    const link = buildConnectLink({ urls: ['http://192.168.1.20:4082', 'http://10.0.0.5:4082'], key: KEY })
    await act(async () => openUrls?.([link]))
    await waitFor(() => expect(latest?.request?.baseUrl).toBe('http://10.0.0.5:4082'))
  })

  it('opens the dialog again when the same QR code is scanned again', async () => {
    online.add('http://192.168.1.20:4082')
    let openUrls: ((urls: string[]) => void) | undefined
    onOpenUrl.mockImplementation(async (handler) => {
      openUrls = handler as (urls: string[]) => void
      return () => {}
    })
    render(<Probe />)
    await waitFor(() => expect(openUrls).toBeDefined())

    const link = buildConnectLink({ urls: ['http://192.168.1.20:4082'], key: KEY })
    await act(async () => openUrls?.([link]))
    await waitFor(() => expect(latest?.request).not.toBeNull())
    act(() => latest?.clear())
    expect(latest?.request).toBeNull()

    await act(async () => openUrls?.([link]))
    await waitFor(() => expect(latest?.request).toEqual({ baseUrl: 'http://192.168.1.20:4082', accessKey: KEY }))
  })

  it('does not replay a handled link after the page reloads', async () => {
    // The deep-link plugin keeps reporting the last opened URL from
    // getCurrent() for the life of the app, including after Save & Connect
    // reloads the page.
    online.add('http://192.168.1.20:4082')
    getCurrent.mockImplementation(() => Promise.resolve([buildConnectLink({ urls: ['http://192.168.1.20:4082'], key: KEY })]))
    render(<Probe />)
    await waitFor(() => expect(latest?.request).not.toBeNull())
    cleanup()

    getCurrent.mockClear()
    render(<Probe />)
    await waitFor(() => expect(getCurrent).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest?.request).toBeNull()
  })

  it('does not reopen the dialog when iOS reloads the page of a server it is already connected to', async () => {
    // iOS kills the backgrounded WebContent process and Tauri reloads the
    // page. getCurrent() still reports the scanned link, and the
    // sessionStorage record of having shown it may be gone with the process.
    online.add('http://192.168.1.20:4082')
    activeBaseUrl = 'http://192.168.1.20:4082'
    window.localStorage.setItem('openagentd.accessKey:http://192.168.1.20:4082', KEY)
    getCurrent.mockImplementation(() => Promise.resolve([buildConnectLink({ urls: ['http://10.0.0.5:4082', 'http://192.168.1.20:4082'], key: KEY })]))
    render(<Probe />)
    await waitFor(() => expect(getCurrent).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest?.request).toBeNull()
  })

  it('still offers a replayed link whose access key differs from the saved one', async () => {
    online.add('http://192.168.1.20:4082')
    activeBaseUrl = 'http://192.168.1.20:4082'
    window.localStorage.setItem('openagentd.accessKey:http://192.168.1.20:4082', 'old-key')
    getCurrent.mockImplementation(() => Promise.resolve([buildConnectLink({ urls: ['http://192.168.1.20:4082'], key: KEY })]))
    render(<Probe />)
    await waitFor(() => expect(latest?.request).toEqual({ baseUrl: 'http://192.168.1.20:4082', accessKey: KEY }))
  })

  it('opens the dialog for a fresh scan of the server already connected', async () => {
    online.add('http://192.168.1.20:4082')
    activeBaseUrl = 'http://192.168.1.20:4082'
    window.localStorage.setItem('openagentd.accessKey:http://192.168.1.20:4082', KEY)
    let openUrls: ((urls: string[]) => void) | undefined
    onOpenUrl.mockImplementation(async (handler) => {
      openUrls = handler as (urls: string[]) => void
      return () => {}
    })
    render(<Probe />)
    await waitFor(() => expect(openUrls).toBeDefined())

    await act(async () => openUrls?.([buildConnectLink({ urls: ['http://192.168.1.20:4082'], key: KEY })]))
    await waitFor(() => expect(latest?.request).toEqual({ baseUrl: 'http://192.168.1.20:4082', accessKey: KEY }))
  })

  it('falls back to the first address when none answer', async () => {
    getCurrent.mockImplementation(() => Promise.resolve([buildConnectLink({ urls: ['http://192.168.1.20:4082', 'http://10.0.0.5:4082'], key: KEY })]))
    render(<Probe />)
    await waitFor(() => expect(latest?.request?.baseUrl).toBe('http://192.168.1.20:4082'))
  })

  it('ignores other and invalid links', async () => {
    getCurrent.mockImplementation(() => Promise.resolve([
      'openagentd://session/abc',
      'openagentd://connect?url=javascript%3Aalert(1)&key=x',
    ]))
    render(<Probe />)
    await waitFor(() => expect(getCurrent).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest?.request).toBeNull()
  })

  it('leaves links to the main window', async () => {
    currentWindowLabel = 'window-2'
    render(<Probe />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onOpenUrl).not.toHaveBeenCalled()
    expect(getCurrent).not.toHaveBeenCalled()
  })
})
