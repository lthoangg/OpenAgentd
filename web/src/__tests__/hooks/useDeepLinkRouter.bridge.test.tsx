import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useDeepLinkRouter } from '@/hooks/useDeepLinkRouter'

const getCurrent = mock(() => Promise.resolve([] as string[]))
const onOpenUrl = mock((_handler: unknown) => Promise.resolve(() => {}))
const navigate = mock(() => Promise.resolve())
const invalidateQueries = mock(() => Promise.resolve())
const pushToast = mock(() => {})
let currentWindowLabel = 'main'

mock.module('@tauri-apps/plugin-deep-link', () => ({ getCurrent, onOpenUrl }))
mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: currentWindowLabel }),
}))
mock.module('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }))
mock.module('@/lib/query-client', () => ({ queryClient: { invalidateQueries } }))
mock.module('@/stores/useToastStore', () => ({
  useToastStore: { getState: () => ({ push: pushToast }) },
}))

function DeepLinkRouter() {
  useDeepLinkRouter()
  return null
}

beforeEach(() => {
  currentWindowLabel = 'main'
  getCurrent.mockReset()
  getCurrent.mockImplementation(() => Promise.resolve([]))
  onOpenUrl.mockReset()
  onOpenUrl.mockImplementation(() => Promise.resolve(() => {}))
  navigate.mockReset()
  invalidateQueries.mockReset()
  pushToast.mockReset()
  globalThis.fetch = mock(async () => new Response(null, { status: 200 }))
})

afterEach(() => {
  cleanup()
})

describe('useDeepLinkRouter Tauri deep-link bridge', () => {
  it('processes cold-start URLs, refreshes providers, and reports callback success', async () => {
    getCurrent.mockImplementation(() => Promise.resolve([
      'openagentd://auth/callback?provider=codex&code=cold-code',
      'openagentd://cockpit/cold-session',
    ]))

    render(<DeepLinkRouter />)

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/codex/callback', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'cold-code' }),
      }))
      expect(invalidateQueries).toHaveBeenCalledTimes(1)
      expect(navigate).toHaveBeenCalledWith({ href: '/cockpit/cold-session' })
      expect(pushToast).toHaveBeenCalledWith({ tone: 'success', title: 'Authentication connected' })
    })
    expect(getCurrent).toHaveBeenCalledTimes(1)
    expect(onOpenUrl).toHaveBeenCalledTimes(1)
  })

  it('processes warm URLs and unregisters the plugin listener on unmount', async () => {
    let openUrls: ((urls: string[]) => void) | undefined
    const unlisten = mock(() => {})
    onOpenUrl.mockImplementation(async (handler) => {
      openUrls = handler as (urls: string[]) => void
      return unlisten
    })

    const view = render(<DeepLinkRouter />)
    await waitFor(() => expect(openUrls).toBeDefined())

    await act(async () => openUrls?.(['openagentd://session/warm-session']))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ href: '/cockpit/warm-session' }))

    view.unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('reports callback failure without refreshing providers', async () => {
    let openUrls: ((urls: string[]) => void) | undefined
    onOpenUrl.mockImplementation(async (handler) => {
      openUrls = handler as (urls: string[]) => void
      return () => {}
    })
    globalThis.fetch = mock(async () => new Response(null, { status: 400 }))

    render(<DeepLinkRouter />)
    await waitFor(() => expect(openUrls).toBeDefined())

    await act(async () => openUrls?.(['openagentd://auth/callback?provider=codex&code=bad-code']))
    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith({ tone: 'error', title: 'Authentication failed' })
    })
    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it('does not exchange the same OAuth callback twice across cold and warm delivery', async () => {
    const callbackUrl = 'openagentd://auth/callback?provider=codex&code=one-use-code'
    let openUrls: ((urls: string[]) => void) | undefined
    getCurrent.mockImplementation(() => Promise.resolve([callbackUrl]))
    onOpenUrl.mockImplementation(async (handler) => {
      openUrls = handler as (urls: string[]) => void
      return () => {}
    })

    render(<DeepLinkRouter />)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))

    await act(async () => openUrls?.([callbackUrl]))
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('leaves deep-link ownership to the main window', async () => {
    currentWindowLabel = 'main-1'

    render(<DeepLinkRouter />)

    await waitFor(() => expect(onOpenUrl).not.toHaveBeenCalled())
    expect(getCurrent).not.toHaveBeenCalled()
  })
})

export {}
