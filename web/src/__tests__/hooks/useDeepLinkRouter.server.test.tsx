/**
 * On the phone, a session link that names its server (a widget's `?srv=`
 * token) opens the session there, switching servers first when needed.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
let os = 'ios'
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => ({ isTauri: true, os, isMacOverlay: false, isFullscreen: false }) }))

const getCurrent = mock(() => Promise.resolve([] as string[]))
mock.module('@tauri-apps/plugin-deep-link', () => ({ getCurrent, onOpenUrl: async () => () => {} }))
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
const navigate = mock(() => Promise.resolve())
mock.module('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }))
const openSessionOnServer = mock(async (..._args: unknown[]) => 'switching' as const)
mock.module('@/lib/open-on-server', () => ({ openSessionOnServer }))

const { useDeepLinkRouter } = await import('@/hooks/useDeepLinkRouter')
const { serverToken } = await import('@/lib/server-refs')

function DeepLinkRouter() {
  useDeepLinkRouter()
  return null
}

beforeEach(() => {
  os = 'ios'
  localStorage.clear()
  sessionStorage.clear()
  navigate.mockClear()
  openSessionOnServer.mockClear()
})

afterEach(cleanup)

describe('session links that name their server', () => {
  it('opens a widget session on the server the widget showed', async () => {
    const token = serverToken({ baseUrl: 'http://127.0.0.1:5999', deviceId: 'dev-linux' })
    getCurrent.mockImplementation(() => Promise.resolve([`openagentd://session/s-linux?srv=${token}`]))
    render(<DeepLinkRouter />)
    await waitFor(() => expect(openSessionOnServer).toHaveBeenCalledTimes(1))
    expect(openSessionOnServer.mock.calls[0][0]).toEqual({ sessionId: 's-linux', deviceId: 'dev-linux', baseUrl: 'http://127.0.0.1:5999' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('opens on the server in use when the token is unknown (another install, or forgotten)', async () => {
    getCurrent.mockImplementation(() => Promise.resolve(['openagentd://session/s1?srv=unknowntoken1']))
    render(<DeepLinkRouter />)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ href: '/s1' }))
    expect(openSessionOnServer).not.toHaveBeenCalled()
  })

  it('keeps one token per server, following an account computer to a new bridge address', () => {
    const first = serverToken({ baseUrl: 'http://127.0.0.1:5999', deviceId: 'dev-mac' })
    expect(serverToken({ baseUrl: 'http://127.0.0.1:6123', deviceId: 'dev-mac' })).toBe(first)
    expect(serverToken({ baseUrl: 'http://192.168.1.30:4082' })).not.toBe(first)
    expect(serverToken({})).toBeNull()
  })
})
