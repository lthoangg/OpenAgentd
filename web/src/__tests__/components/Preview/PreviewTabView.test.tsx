import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { PreviewTabView } from '@/components/Preview/PreviewTabView'
import { PREVIEW_NS } from '@/components/Preview/preview-protocol'
import type { PreviewTarget } from '@/api/preview'
import type { DesignFeedback } from '@/lib/design-feedback'
import { buildDesignFeedback } from '@/components/Preview/preview-comments'
import { useReturnedFeedbackStore } from '@/stores/useReturnedFeedbackStore'

const WS = '/Users/me/project'
const ORIGIN = 'http://127.0.0.1:52011'
const RELAY_ORIGIN = 'http://127.0.0.1:61000'
// The native relay (`preview_relay_open`) when the app talks to a remote server.
let relayError: string | null = null
const invokeMock = mock(async (..._args: unknown[]) => {
  // Tauri rejects with the command's error string.
  if (relayError) throw relayError
  return { port: 61000, origin: RELAY_ORIGIN }
})
mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
const originalFetch = globalThis.fetch
let previewBodies: Record<string, unknown>[] = []
let workspaceFiles: { path: string; mtime: number }[] = []
// Workspace paths the preview API answers as "not a file".
let missingPaths = new Set<string>()

// The previewed page is simulated with postMessage: answer the iframe's own
// page load locally instead of reaching for the network.
type Interceptor = { beforeAsyncRequest?: (args: { request: Request }) => Promise<Response | void> }
const happyDOM = (window as unknown as { happyDOM?: { settings: { fetch: { interceptor: Interceptor | null } } } }).happyDOM
if (happyDOM) {
  happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request }) => (request.url.startsWith(ORIGIN) || request.url.startsWith(RELAY_ORIGIN) ? new Response('<!doctype html><html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) : undefined),
  }
}

beforeEach(() => {
  localStorage.clear()
  previewBodies = []
  workspaceFiles = []
  missingPaths = new Set()
  globalThis.fetch = mock(async (input: unknown, raw?: unknown) => {
    const url = String(input)
    const init = raw as RequestInit | undefined
    if (url.endsWith('/api/preview')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      previewBodies.push(body)
      if (typeof body.path === 'string' && missingPaths.has(body.path)) {
        return new Response(JSON.stringify({ detail: `'${body.path}' is not a file in the workspace.` }), { status: 422 })
      }
      const path = body.path ? `/${String(body.path)}` : '/pricing'
      return new Response(JSON.stringify({ id: 'p1', workspace: WS, kind: body.path ? 'file' : 'url', target: body.path ? WS : 'http://localhost:5173', port: 52011, origin: ORIGIN, path, url: `${ORIGIN}${path}`, console_errors: 0 }))
    }
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WS, truncated: false, files: workspaceFiles }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  delete (window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  invokeMock.mockClear()
  relayError = null
})

async function renderView(
  target: PreviewTarget = { kind: 'url', url: 'http://localhost:5173/pricing' },
  onSendComments = mock((_text: unknown) => {}),
  onOpenTarget = mock((..._args: unknown[]) => {}),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // happy-dom loads the iframe's page itself (answered by the interceptor
  // above) and fires a real `load` some time after mount, which runs
  // `onFrameLoad`. Wait for it here: on a busy CPU it otherwise lands in the
  // middle of a test's own scripted loads. Capture on the document so a load
  // during mount is not missed.
  const pageLoaded = new Promise<void>((resolve) => {
    const onLoad = (event: Event) => {
      if (!(event.target instanceof HTMLIFrameElement)) return
      document.removeEventListener('load', onLoad, true)
      resolve()
    }
    document.addEventListener('load', onLoad, true)
  })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewTabView workspace={WS} tabId="preview:1" target={target} navKey={0} onSendComments={onSendComments} onOpenTarget={onOpenTarget} />
      </QueryClientProvider>,
    )
  })
  const iframe = await waitFor(() => {
    const el = document.querySelector('iframe')
    if (!el) throw new Error('no iframe yet')
    return el as HTMLIFrameElement
  })
  await act(() => pageLoaded)
  const frameWindow = iframe.contentWindow as Window
  const commands: Record<string, unknown>[] = []
  frameWindow.postMessage = ((data: Record<string, unknown>) => commands.push(data)) as typeof frameWindow.postMessage
  return { iframe, frameWindow, commands, onSendComments, onOpenTarget }
}

function fromPage(frameWindow: Window, data: Record<string, unknown>, origin = ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { ns: PREVIEW_NS, v: 1, ...data }, origin, source: frameWindow }))
  })
}

/** Type into the address bar and press Enter. */
function enterAddress(value: string) {
  const address = screen.getByRole('textbox', { name: 'Preview address' })
  fireEvent.focus(address)
  fireEvent.change(address, { target: { value } })
  fireEvent.submit(address.closest('form') as HTMLFormElement)
}

const element = {
  selector: 'main > button.cta',
  tag: 'button',
  id: null,
  classes: ['cta'],
  text: 'Start free',
  html: '<button class="cta">',
  rect: { x: 10, y: 10, width: 80, height: 20 },
  styles: {},
  source: { file: `${WS}/src/Pricing.tsx`, line: 42, component: 'Pricing' },
  path: '/pricing',
}

describe('PreviewTabView', () => {
  /** Ready the page, turn Design on, pick the element, and add a comment. */
  async function addComment(frameWindow: Window, text: string, picked: typeof element = element) {
    fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
    const design = await waitFor(() => {
      const button = screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement
      if (button.disabled) throw new Error('not ready')
      return button
    })
    fireEvent.click(design)
    fromPage(frameWindow, { type: 'select', element: picked })
    const box = await screen.findByRole('textbox', { name: 'Comment' })
    fireEvent.change(box, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    await screen.findByText(text)
  }

  it('frames the preview listener and shows the dev server address', async () => {
    const { iframe } = await renderView()
    expect(iframe.getAttribute('src')).toBe(`${ORIGIN}/pricing`)
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(previewBodies[0]).toEqual({ workspace: WS, url: 'http://localhost:5173/pricing' })
    const address = screen.getByRole('textbox', { name: 'Preview address' }) as HTMLInputElement
    await waitFor(() => expect(address.value).toBe('http://localhost:5173/pricing'))
  })

  it('enables Design only once the page reports ready from its own origin', async () => {
    const { frameWindow } = await renderView()
    const design = () => screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement
    expect(design().disabled).toBe(true)
    fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' }, 'http://evil.example')
    expect(design().disabled).toBe(true)
    fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
    await waitFor(() => expect(design().disabled).toBe(false))
    expect((screen.getByRole('textbox', { name: 'Preview address' }) as HTMLInputElement).value).toBe('http://localhost:5173/pricing')
  })

  it('collects design comments and sends them to the composer', async () => {
    const { frameWindow, commands, onSendComments } = await renderView()
    fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
    const design = await waitFor(() => {
      const button = screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement
      if (button.disabled) throw new Error('not ready')
      return button
    })
    fireEvent.click(design)
    await waitFor(() => expect(commands.some((c) => c.type === 'set-mode' && c.mode === 'inspect')).toBe(true))
    expect(design.getAttribute('aria-pressed')).toBe('true')

    fromPage(frameWindow, { type: 'select', element })
    const box = await screen.findByRole('textbox', { name: 'Comment' })
    fireEvent.change(box, { target: { value: 'Make this larger' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    expect(await screen.findByText('1 comment')).toBeTruthy()
    await waitFor(() => expect(commands.some((c) => c.type === 'pins' && Array.isArray(c.pins) && c.pins.length === 1)).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: /Send to agent/ }))
    expect(onSendComments).toHaveBeenCalledTimes(1)
    const feedback = onSendComments.mock.calls[0][0] as DesignFeedback
    expect(feedback.where).toBe('http://localhost:5173/pricing')
    expect(feedback.items).toEqual([expect.objectContaining({ n: 1, element: '<button.cta>', text: 'Start free', selector: 'main > button.cta', source: '@src/Pricing.tsx#L42-L71', comment: 'Make this larger' })])
    expect(screen.queryByText('1 comment')).toBeNull()
  })

  it('edits a comment in the list, and keeps picking after each comment', async () => {
    const { frameWindow, commands, onSendComments } = await renderView()
    await addComment(frameWindow, 'Make this larger')
    // Design stays on: the next element is one click away.
    expect(screen.getByRole('button', { name: /Stop picking/ }).getAttribute('aria-pressed')).toBe('true')
    expect(commands.filter((c) => c.type === 'set-mode').at(-1)?.mode).toBe('inspect')

    fireEvent.click(screen.getByRole('button', { name: 'Edit comment 1' }))
    const box = screen.getByRole('textbox', { name: 'Edit comment 1' })
    fireEvent.change(box, { target: { value: 'Make this much larger' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(screen.getByText('Make this much larger')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Edit comment 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment 1' }), { target: { value: 'discarded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
    expect(screen.queryByText('discarded')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Send to agent/ }))
    expect((onSendComments.mock.calls[0][0] as DesignFeedback).items[0].comment).toBe('Make this much larger')
  })

  it('toggles picking with Alt+C from the dock or the page', async () => {
    const { frameWindow } = await renderView()
    fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
    const pressed = () => screen.getByRole('button', { name: /Design|Stop picking/ }).getAttribute('aria-pressed')
    await waitFor(() => expect((screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByRole('button', { name: /Design/ }).getAttribute('aria-label')).toMatch(/\((⌥C|Alt\+C)\)/)

    fireEvent.keyDown(window, { key: 'ç', code: 'KeyC', altKey: true })
    expect(pressed()).toBe('true')
    // Typing in a field is left alone.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Preview address' }), { key: 'ç', code: 'KeyC', altKey: true })
    expect(pressed()).toBe('true')
    // The page forwards the shortcut when focus is inside it.
    fromPage(frameWindow, { type: 'shortcut', name: 'toggle-design' })
    expect(pressed()).toBe('false')
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC', altKey: true, metaKey: true })
    expect(pressed()).toBe('false')
  })

  it('ignores the shortcut while the tab is in the background', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <PreviewTabView workspace={WS} tabId="preview:1" target={{ kind: 'url', url: 'http://localhost:5173/pricing' }} navKey={0} active={false} />
        </QueryClientProvider>,
      )
    })
    const iframe = await waitFor(() => document.querySelector('iframe') as HTMLIFrameElement)
    fromPage(iframe.contentWindow as Window, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
    await waitFor(() => expect((screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.keyDown(window, { key: 'ç', code: 'KeyC', altKey: true })
    expect(screen.getByRole('button', { name: /Design/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('closes its tab when the page forwards the close-tab shortcut', async () => {
    const onRequestClose = mock((_tabId: unknown) => {})
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (active: boolean) => (
      <QueryClientProvider client={queryClient}>
        <PreviewTabView workspace={WS} tabId="preview:1" target={{ kind: 'url', url: 'http://localhost:5173/pricing' }} navKey={0} active={active} onRequestClose={onRequestClose} />
      </QueryClientProvider>
    )
    let rerender: (ui: React.ReactElement) => void = () => {}
    await act(async () => { rerender = render(view(false)).rerender })
    const iframe = await waitFor(() => document.querySelector('iframe') as HTMLIFrameElement)
    const frameWindow = iframe.contentWindow as Window
    // A background tab never closes itself.
    fromPage(frameWindow, { type: 'shortcut', name: 'close-tab' })
    expect(onRequestClose).not.toHaveBeenCalled()

    await act(async () => { rerender(view(true)) })
    fromPage(frameWindow, { type: 'shortcut', name: 'close-tab' })
    expect(onRequestClose).toHaveBeenCalledWith('preview:1')
    // Messages from anywhere else are ignored.
    fromPage(frameWindow, { type: 'shortcut', name: 'close-tab' }, 'http://evil.example')
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('sends the page its keymap and replays forwarded keys through the app', async () => {
    const { iframe, frameWindow, commands } = await renderView()
    fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
    await waitFor(() => expect(commands.some((c) => c.type === 'keymap')).toBe(true))
    const keymap = commands.find((c) => c.type === 'keymap')?.keymap as { chords: { key: string; alt: boolean }[]; escape: boolean }
    expect(keymap.escape).toBe(true)
    expect(keymap.chords).toContainEqual(expect.objectContaining({ key: 'c', alt: true }))
    expect(keymap.chords).toContainEqual(expect.objectContaining({ key: 'w' }))

    const design = await waitFor(() => {
      const button = screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement
      if (button.disabled) throw new Error('not ready')
      return button
    })
    iframe.focus()
    const forward = (origin: string) => act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { ns: 'openagentd-keys', v: 1, type: 'key', key: 'ç', code: 'KeyC', altKey: true },
        origin,
        source: frameWindow,
      }))
    })
    forward('http://evil.example')
    expect(design.getAttribute('aria-pressed')).toBe('false')
    forward(ORIGIN)
    expect(design.getAttribute('aria-pressed')).toBe('true')
  })

  it('counts console errors from the page', async () => {
    const { frameWindow } = await renderView()
    fromPage(frameWindow, { type: 'console', entries: [{ level: 'error', message: 'boom', url: '/', ts: 0 }, { level: 'log', message: 'hi', url: '/', ts: 0 }] })
    const button = await screen.findByRole('button', { name: 'Console (1 errors)' })
    fireEvent.click(button)
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.getByText('2 entries')).toBeTruthy()
  })

  it('keeps the tools when the page reloads again before the first load is judged', async () => {
    const { iframe, frameWindow, commands } = await renderView({ kind: 'url', url: 'http://localhost:5173/#features' })
    // Page 1: ready on DOMContentLoaded, then load, answered hello.
    fromPage(frameWindow, { type: 'ready', path: '/', title: 'A', status: 'ok' })
    fireEvent.load(iframe)
    fromPage(frameWindow, { type: 'ready', path: '/', title: 'A', status: 'ok' })
    // Page 2 (a dev-server full reload) lands inside the grace window.
    await new Promise((resolve) => setTimeout(resolve, 300))
    fromPage(frameWindow, { type: 'ready', path: '/#features', title: 'A', status: 'ok' })
    fireEvent.load(iframe)
    fromPage(frameWindow, { type: 'ready', path: '/#features', title: 'A', status: 'ok' })
    expect(commands.filter((c) => c.type === 'hello')).toHaveLength(2)
    // Past the first load's grace period and the second's.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(screen.queryByText(/did not load the preview script/)).toBeNull()
    expect((screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says so when a loaded page never answers the inspector', async () => {
    const { iframe } = await renderView()
    fireEvent.load(iframe)
    expect(await screen.findByText(/did not load the preview script/, undefined, { timeout: 2000 })).toBeTruthy()
    expect((screen.getByRole('button', { name: /Design/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows when the agent is using the page', async () => {
    const { frameWindow } = await renderView()
    expect(screen.queryByRole('status', { name: /agent/i })).toBeNull()
    fromPage(frameWindow, { type: 'agent', action: 'click' }, 'http://evil.example')
    expect(screen.queryByText(/is using this page/)).toBeNull()
    fromPage(frameWindow, { type: 'agent', action: 'click' })
    expect(screen.getByText('is using this page: click')).toBeTruthy()
  })

  it('takes back feedback removed from the composer into its comment list', async () => {
    const feedback = buildDesignFeedback({
      comments: [{ id: 'x', n: 1, element: { ...element, role: null, ariaLabel: null }, text: 'Make this larger' }],
      workspace: WS,
      origin: 'http://localhost:5173',
      device: 'Desktop',
    })
    // For another workspace or another dev server: not ours.
    useReturnedFeedbackStore.getState().give({ workspace: '/elsewhere', feedback })
    useReturnedFeedbackStore.getState().give({ workspace: WS, feedback: { ...feedback, where: 'http://localhost:3000/' } })
    useReturnedFeedbackStore.getState().give({ workspace: WS, feedback })
    const { frameWindow, commands, onSendComments } = await renderView()
    expect(await screen.findByText('Make this larger')).toBeTruthy()
    expect(screen.getByText('1 comment')).toBeTruthy()
    expect(useReturnedFeedbackStore.getState().items).toHaveLength(2)
    // The page pins it once loaded.
    fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
    await waitFor(() => expect(commands.some((c) => c.type === 'pins' && Array.isArray(c.pins) && c.pins.length === 1)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /Send to agent/ }))
    expect((onSendComments.mock.calls[0][0] as DesignFeedback).items).toEqual(feedback.items)
    useReturnedFeedbackStore.setState({ items: [] })
  })

  it('places dev-server source paths (React 19) in the workspace', async () => {
    workspaceFiles = [{ path: 'web/src/Pricing.tsx', mtime: 0 }, { path: 'web/src/main.tsx', mtime: 0 }]
    const { frameWindow, onSendComments } = await renderView()
    await addComment(frameWindow, 'Bigger', { ...element, source: { file: '/src/Pricing.tsx', line: 42, component: 'Pricing' } })
    fireEvent.click(screen.getByRole('button', { name: /Send to agent/ }))
    expect((onSendComments.mock.calls[0][0] as DesignFeedback).items[0].source).toBe('@web/src/Pricing.tsx#L42-L71')
  })

  it('asks for the file path for workspace file previews', async () => {
    const { iframe } = await renderView({ kind: 'file', path: 'designs/landing.html' })
    expect(previewBodies[0]).toEqual({ workspace: WS, path: 'designs/landing.html' })
    expect(iframe.getAttribute('src')).toBe(`${ORIGIN}/designs/landing.html`)
  })

  describe('address bar', () => {
    it('opens a workspace file typed in a dev-server tab in its own tab', async () => {
      const { onOpenTarget } = await renderView()
      enterAddress('./web/.preview/index.html')
      await waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'file', path: 'web/.preview/index.html' }))
      expect(previewBodies.at(-1)).toEqual({ workspace: WS, path: 'web/.preview/index.html' })
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('opens a pasted full path inside the workspace as a file', async () => {
      const { onOpenTarget } = await renderView()
      enterAddress(`${WS}/docs/mockup.html`)
      await waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'file', path: 'docs/mockup.html' }))
    })

    it('reports a missing file in place without opening a tab', async () => {
      missingPaths.add('nope.html')
      const { onOpenTarget } = await renderView()
      enterAddress('nope.html')
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain("'nope.html' is not a file in the workspace. Start with / for a page on localhost:5173.")
      expect(onOpenTarget).not.toHaveBeenCalled()
    })

    it('falls back to the dev server for a full path that is not a workspace file', async () => {
      missingPaths.add('settings')
      const { frameWindow, commands, onOpenTarget } = await renderView()
      fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
      enterAddress(`${WS}/settings`)
      await waitFor(() => expect(commands).toContainEqual(expect.objectContaining({ type: 'navigate', path: `${WS}/settings` })))
      expect(onOpenTarget).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('keeps rooted paths and other local servers working as before', async () => {
      const { frameWindow, commands, onOpenTarget } = await renderView()
      fromPage(frameWindow, { type: 'ready', path: '/pricing', title: 'Pricing', status: 'ok' })
      enterAddress('/about')
      await waitFor(() => expect(commands).toContainEqual(expect.objectContaining({ type: 'navigate', path: '/about' })))
      enterAddress('localhost:3000')
      await waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'url', url: 'localhost:3000' }))
      expect(previewBodies.filter((b) => 'path' in b)).toHaveLength(0)
    })

    it('navigates in place when a file tab is given another workspace file', async () => {
      const { frameWindow, commands, onOpenTarget } = await renderView({ kind: 'file', path: 'designs/landing.html' })
      fromPage(frameWindow, { type: 'ready', path: '/designs/landing.html', title: 'Landing', status: 'ok' })
      enterAddress(`${WS}/designs/pricing.html`)
      await waitFor(() => expect(commands).toContainEqual(expect.objectContaining({ type: 'navigate', path: '/designs/pricing.html' })))
      expect(onOpenTarget).not.toHaveBeenCalled()
    })
  })

  it('explains that a browser on another device cannot preview', async () => {
    ;(window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__ = 'http://192.168.1.20:4082'
    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewTabView workspace={WS} tabId="preview:1" target={{ kind: 'url', url: 'http://localhost:5173' }} navKey={0} />
      </QueryClientProvider>,
    )
    expect(screen.getByText("Preview isn't available in this browser")).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    expect(previewBodies).toHaveLength(0)
  })

  it('frames the native relay when the app is connected to a remote server', async () => {
    ;(window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__ = 'http://192.168.1.20:4082'
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewTabView workspace={WS} tabId="preview:1" target={{ kind: 'url', url: 'http://localhost:5173/pricing' }} navKey={0} />
      </QueryClientProvider>,
    )
    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe')
      if (!el) throw new Error('no iframe yet')
      return el
    })
    expect(iframe.getAttribute('src')).toBe(`${RELAY_ORIGIN}/pricing`)
    expect(invokeMock).toHaveBeenCalledWith('preview_relay_open', { previewId: 'p1', port: 52011 })
    const openInBrowser = screen.getByRole('button', { name: /Open in browser/ }) as HTMLButtonElement
    expect(openInBrowser.disabled).toBe(true)
  })

  it('shows why the relay could not open', async () => {
    ;(window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__ = 'http://192.168.1.20:4082'
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    relayError = "Previews on this device need this server's access key."
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewTabView workspace={WS} tabId="preview:1" target={{ kind: 'url', url: 'http://localhost:5173' }} navKey={0} />
      </QueryClientProvider>,
    )
    expect((await screen.findByRole('alert')).textContent).toContain("need this server's access key")
    expect(document.querySelector('iframe')).toBeNull()
  })
})
