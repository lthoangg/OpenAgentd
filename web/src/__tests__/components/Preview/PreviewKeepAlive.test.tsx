import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'

import { PreviewKeepAlive } from '@/components/Preview/PreviewKeepAlive'
import { previewListenerKey, usePreviewKeepAliveStore } from '@/stores/usePreviewKeepAliveStore'

const WS = '/Users/me/project'
const ORIGIN = 'http://127.0.0.1:52011'
const TARGET = { kind: 'url', url: 'http://localhost:5173/pricing' } as const
const KEY = previewListenerKey(WS, TARGET)

let isMobile = false
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile, MOBILE_QUERY: '(max-width: 767px)' }))

const originalFetch = globalThis.fetch
let openCalls = 0
let failOpen = false

// The page is not loaded from the network: answer the iframe's own load locally.
type Interceptor = { beforeAsyncRequest?: (args: { request: Request }) => Promise<Response | void> }
const happyDOM = (window as unknown as { happyDOM?: { settings: { fetch: { interceptor: Interceptor | null } } } }).happyDOM
if (happyDOM) {
  happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request }) => (request.url.startsWith(ORIGIN) ? new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html' } }) : undefined),
  }
}

beforeEach(() => {
  isMobile = false
  openCalls = 0
  failOpen = false
  usePreviewKeepAliveStore.getState().reset()
  globalThis.fetch = mock(async (input: unknown) => {
    if (String(input).endsWith('/api/preview')) {
      openCalls += 1
      if (failOpen) return new Response(JSON.stringify({ detail: 'nope' }), { status: 422 })
      return new Response(JSON.stringify({ id: 'p1', workspace: WS, kind: 'url', target: 'http://localhost:5173', port: 52011, origin: ORIGIN, path: '/pricing', url: `${ORIGIN}/pricing`, console_errors: 0 }))
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const frames = () => Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-preview-keep-alive]'))
/** The hidden frame waits briefly before opening, so a closing tab can drop its entry first. */
const SLOW = { timeout: 4000 }

describe('PreviewKeepAlive', () => {
  it('renders nothing while the agent opened no preview', () => {
    render(<PreviewKeepAlive />)
    expect(frames()).toHaveLength(0)
  })

  it('frames an agent-opened preview off-screen, as a real but inert page', async () => {
    render(<PreviewKeepAlive />)
    act(() => usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET))
    await waitFor(() => expect(frames()).toHaveLength(1), SLOW)
    const frame = frames()[0] as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(`${ORIGIN}/pricing`)
    // In the app document itself, not nested in another frame.
    expect(frame.ownerDocument).toBe(document)
    expect(document.body.contains(frame)).toBe(true)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads')
    expect(frame.getAttribute('aria-hidden')).toBe('true')
    expect(frame.getAttribute('tabindex')).toBe('-1')
    expect(frame.title).toContain('http://localhost:5173/pricing')
    // Laid out at full size but transparent, with one pixel column still on
    // screen: WebKit throttles a fully off-screen frame's timers (~40×), and
    // the page's script skips display:none / visibility:hidden.
    expect(frame.style.position).toBe('fixed')
    expect(frame.style.left).toBe('-1279px')
    expect(frame.style.width).toBe('1280px')
    expect(frame.style.height).toBe('800px')
    expect(frame.style.opacity).toBe('0')
    expect(frame.style.pointerEvents).toBe('none')
    expect(frame.style.display).not.toBe('none')
    expect(frame.style.visibility).not.toBe('hidden')
    expect(usePreviewKeepAliveStore.getState().agent[KEY]?.previewId).toBe('p1')
  })

  it('hands focus back when the hidden page takes it (an agent fill), so typing stays in the app', async () => {
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    try {
      render(<PreviewKeepAlive />)
      act(() => usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET))
      await waitFor(() => expect(frames()).toHaveLength(1), SLOW)
      input.focus()
      expect(document.activeElement).toBe(input)
      ;(frames()[0] as HTMLIFrameElement).focus()
      await waitFor(() => expect(document.activeElement).toBe(input))
    } finally {
      input.remove()
    }
  })

  it('does not frame a preview a Preview tab shows, and drops its copy when a tab mounts', async () => {
    render(<PreviewKeepAlive />)
    act(() => {
      usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET)
      usePreviewKeepAliveStore.getState().showTab('tab-1', KEY)
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 1800)))
    expect(frames()).toHaveLength(0)
    expect(openCalls).toBe(0)

    act(() => usePreviewKeepAliveStore.getState().hideTab('tab-1'))
    await waitFor(() => expect(frames()).toHaveLength(1), SLOW)

    // The tab opens (with the listener id): exactly one page polls.
    act(() => usePreviewKeepAliveStore.getState().showTab('tab-2', KEY, 'p1'))
    await waitFor(() => expect(frames()).toHaveLength(0))
  })

  it('stops framing an expired or closed preview', async () => {
    render(<PreviewKeepAlive />)
    act(() => usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET))
    await waitFor(() => expect(frames()).toHaveLength(1), SLOW)
    act(() => usePreviewKeepAliveStore.getState().expire(Date.now() + 16 * 60_000))
    await waitFor(() => expect(frames()).toHaveLength(0))

    act(() => usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET))
    await waitFor(() => expect(frames()).toHaveLength(1), SLOW)
    act(() => usePreviewKeepAliveStore.getState().forgetPreviewId('p1'))
    await waitFor(() => expect(frames()).toHaveLength(0))
  })

  it('drops a preview the backend cannot open', async () => {
    failOpen = true
    render(<PreviewKeepAlive />)
    act(() => usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET))
    await waitFor(() => expect(usePreviewKeepAliveStore.getState().agent[KEY]).toBeUndefined(), SLOW)
    expect(frames()).toHaveLength(0)
  })

  it('is off on a phone', async () => {
    isMobile = true
    render(<PreviewKeepAlive />)
    act(() => usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET))
    await act(() => new Promise((resolve) => setTimeout(resolve, 1800)))
    expect(frames()).toHaveLength(0)
    expect(openCalls).toBe(0)
  })

  it('is off where previews cannot work (a browser on another device)', async () => {
    ;(window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__ = 'https://oad.example.com/api'
    try {
      render(<PreviewKeepAlive />)
      act(() => usePreviewKeepAliveStore.getState().registerAgent(WS, TARGET))
      await act(() => new Promise((resolve) => setTimeout(resolve, 1800)))
      expect(frames()).toHaveLength(0)
      expect(openCalls).toBe(0)
    } finally {
      delete (window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__
    }
  })
})
