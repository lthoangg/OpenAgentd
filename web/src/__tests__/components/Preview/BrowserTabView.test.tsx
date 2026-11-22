/**
 * A Preview tab on a page of the public web. The desktop shell (`invoke`,
 * its events) and the server (`fetch`) are stand-ins; the native view
 * itself is outside what a test can show.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import * as realPlatform from '@/hooks/use-platform'

let platform = { isTauri: true, os: 'macos' as realPlatform.OS, isMacOverlay: true, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => platform, usePlatform: () => platform }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false, MOBILE_QUERY: '(max-width: 767px)' }))

type Listener = (event: { payload: unknown }) => void
let invoked: { command: string; args: Record<string, unknown> | undefined }[] = []
let listeners: Listener[] = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    invoked.push({ command, args })
    return undefined
  },
}))
mock.module('@tauri-apps/api/event', () => ({
  listen: async (_name: string, handler: Listener) => {
    listeners.push(handler)
    return () => {
      listeners = listeners.filter((l) => l !== handler)
    }
  },
}))
const openedOutside = mock(async (..._args: unknown[]) => {})
mock.module('@/lib/open-external', () => ({ openExternalUrl: openedOutside }))

import { BrowserTabView, stageFrame } from '@/components/Preview/BrowserTabView'
import { browserViewId } from '@/lib/browser-view'
import type { DesignFeedback } from '@/lib/design-feedback'

const ORIGIN = 'https://shop.example'
const originalFetch = globalThis.fetch
let workspaceCount = 0
let savedRules: unknown[] = []

beforeEach(() => {
  platform = { isTauri: true, os: 'macos', isMacOverlay: true, isFullscreen: false }
  invoked = []
  listeners = []
  savedRules = []
  openedOutside.mockClear()
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/browser/sites')) {
      if (method === 'PUT') savedRules.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(method === 'PUT' ? JSON.parse(String(init?.body)) : { default: 'ask', allowed: [], blocked: [] }))
    }
    if (url.endsWith('/preview') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'p1', workspace: '/w', kind: 'site', target: ORIGIN, port: 0, origin: ORIGIN, path: '/', url: `${ORIGIN}/`, console_errors: 0 }))
    }
    if (url.endsWith('/agent') && method === 'GET') {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    return new Response(null, { status: 204 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const calls = (command: string) => invoked.filter((c) => c.command === command).map((c) => c.args)
const emit = (id: string, event: Record<string, unknown>) => act(() => {
  for (const listener of listeners) listener({ payload: { id, ...event } })
})
const pageSays = (id: string, message: Record<string, unknown>) => emit(id, { kind: 'page', url: `${ORIGIN}/cart`, messages: [{ ns: 'openagentd-preview', v: 1, ...message }] })

function renderTab(over: { onOpenTarget?: (target: unknown) => void; onSendComments?: (feedback: DesignFeedback) => void; onRequestClose?: (id: string) => void } = {}) {
  const workspace = `/code/browser-tab-${++workspaceCount}`
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserTabView workspace={workspace} tabId="t1" target={{ kind: 'url', url: `${ORIGIN}/cart` }} navKey={0} {...over} />
    </QueryClientProvider>,
  )
  return { workspace, viewId: browserViewId(workspace, ORIGIN) }
}

function box(left: number, top: number, width: number, height: number): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) })
  return el
}

describe('stageFrame', () => {
  const viewport = { width: 1000, height: 800 }

  it("gives the page area as fractions of the window", () => {
    const stage = box(500, 80, 500, 720)
    expect(stageFrame(stage, viewport, () => stage)).toEqual({ x: 0.5, y: 0.1, width: 0.5, height: 0.9 })
    // A child of the stage (the size caption) is part of it; a point off the screen hits nothing.
    const child = document.createElement('p')
    stage.appendChild(child)
    expect(stageFrame(stage, viewport, (x) => (x > 990 ? null : child))).toEqual({ x: 0.5, y: 0.1, width: 0.5, height: 0.9 })
  })

  it('gives nothing while the area has no size or the app draws over it', () => {
    expect(stageFrame(box(1000, 80, 0, 720), viewport, () => null)).toBeNull()
    expect(stageFrame(box(0, 0, 500, 500), { width: 0, height: 0 }, () => null)).toBeNull()
    const stage = box(500, 80, 500, 720)
    const menu = document.createElement('div')
    // A menu over one corner is enough: the page would cover it.
    expect(stageFrame(stage, viewport, (x, y) => (x > 950 && y < 120 ? menu : stage))).toBeNull()
  })
})

describe('BrowserTabView', () => {
  it('says where public sites open on a client without the native view', () => {
    platform = { isTauri: false, os: 'macos', isMacOverlay: false, isFullscreen: false }
    renderTab()
    expect(screen.getByText('Public sites open in the desktop app')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(openedOutside).toHaveBeenCalledWith(`${ORIGIN}/cart`)
    expect(invoked).toEqual([])
  })

  it('loads the page in a view, out of sight until its area has a size', async () => {
    const { viewId } = renderTab()
    await waitFor(() => expect(calls('browser_view_open')).toEqual([{ id: viewId, url: `${ORIGIN}/cart`, frame: null }]))
    expect((screen.getByLabelText('Preview address') as HTMLInputElement).value).toContain('shop.example/cart')
    await emit(viewId, { kind: 'url', url: `${ORIGIN}/checkout` })
    await waitFor(() => expect((screen.getByLabelText('Preview address') as HTMLInputElement).value).toContain('shop.example/checkout'))
  })

  it('drives the view from the toolbar', async () => {
    const { viewId } = renderTab()
    await waitFor(() => expect(calls('browser_view_open')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(calls('browser_view_go')).toEqual([{ id: viewId, to: 'back' }, { id: viewId, to: 'reload' }]))
  })

  it("shows what the agent may do on the site and changes it", async () => {
    renderTab()
    const picker = await screen.findByRole('button', { name: 'Agent access to shop.example' })
    expect(picker.textContent).toContain('Agent asks first')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'Always allow the agent on shop.example' }))
    await waitFor(() => expect(savedRules).toEqual([{ default: 'ask', allowed: ['shop.example'], blocked: [] }]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent access to shop.example' }).textContent).toContain('Agent allowed'))
  })

  it('frames the page at a device size', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Device size' }))
    fireEvent.click(await screen.findByRole('option', { name: /^Mobile/ }))
    await waitFor(() => expect(document.querySelector('[data-frame-caption]')?.textContent).toBe('390 × 844'))
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeTruthy()
  })

  it('collects comments on picked elements and hands them to the composer', async () => {
    let sent: DesignFeedback | null = null
    const { viewId } = renderTab({ onSendComments: (feedback) => { sent = feedback } })
    await waitFor(() => expect(calls('browser_view_open')).toHaveLength(1))
    // Comment needs the page's script.
    expect((screen.getByRole('button', { name: 'Comment (the page is still loading)' }) as HTMLButtonElement).disabled).toBe(true)
    await pageSays(viewId, { type: 'ready', path: '/cart', title: 'Cart', doc: 'd1' })
    fireEvent.click(await screen.findByRole('button', { name: /^Comment on an element/ }))
    await waitFor(() => expect(calls('browser_view_dock').some((c) => JSON.stringify(c?.command).includes('"type":"set-mode","mode":"inspect"'))).toBe(true))
    expect(screen.getByText('Click an element to comment')).toBeTruthy()

    await pageSays(viewId, { type: 'select', element: { selector: 'button.pay', tag: 'button', classes: ['pay'], text: 'Pay now', rect: { x: 10, y: 20, width: 80, height: 30 }, path: '/cart' } })
    fireEvent.change(await screen.findByRole('textbox', { name: 'Comment' }), { target: { value: 'Make this green' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add comment/ }))
    expect(await screen.findByText('1 comment')).toBeTruthy()
    await waitFor(() => expect(calls('browser_view_dock').some((c) => JSON.stringify(c?.command).includes('"selector":"button.pay"'))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: /^Send to agent/ }))
    expect(sent).not.toBeNull()
    expect(JSON.stringify(sent)).toContain('Make this green')
    expect(JSON.stringify(sent)).toContain(ORIGIN)
    expect(screen.queryByText('1 comment')).toBeNull()
  })

  it('closes the tab when the page forwards Cmd+W, and opens another site in its own tab', async () => {
    const closed: string[] = []
    const targets: unknown[] = []
    const { viewId } = renderTab({ onRequestClose: (id) => closed.push(id), onOpenTarget: (target) => targets.push(target) })
    await waitFor(() => expect(calls('browser_view_open')).toHaveLength(1))
    await pageSays(viewId, { type: 'shortcut', name: 'close-tab' })
    expect(closed).toEqual(['t1'])

    const address = screen.getByLabelText('Preview address')
    fireEvent.change(address, { target: { value: 'docs.example/guide' } })
    fireEvent.submit(address.closest('form') as HTMLFormElement)
    await waitFor(() => expect(targets).toEqual([{ kind: 'url', url: 'https://docs.example/guide' }]))
    // A path stays on this site, in this view.
    fireEvent.change(address, { target: { value: '/orders' } })
    fireEvent.submit(address.closest('form') as HTMLFormElement)
    await waitFor(() => expect(calls('browser_view_open').map((c) => c?.url)).toContain(`${ORIGIN}/orders`))
  })
})
