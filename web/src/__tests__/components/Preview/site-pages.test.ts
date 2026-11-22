/**
 * `SitePage`: the link between the desktop shell's native view of a site
 * and the server. The shell (`invoke`, its events) and the server (`fetch`)
 * are stand-ins here.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

type Listener = (event: { payload: unknown }) => void
let invoked: { command: string; args: Record<string, unknown> | undefined }[] = []
let refuseRun: string | null = null
let listeners: Listener[] = []

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    invoked.push({ command, args })
    if (command === 'browser_view_run' && refuseRun) throw new Error(refuseRun)
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

import { browserViewId } from '@/lib/browser-view'
import { sitePage } from '@/components/Preview/site-pages'

const ORIGIN = 'https://shop.example'
const originalFetch = globalThis.fetch
/** Commands the server hands out, one per poll; with none a poll waits until the page lets go. */
let commands: { id: string; command: Record<string, unknown> }[] = []
let replies: Record<string, unknown>[] = []
let reported: string[] = []
let consoles: unknown[] = []
let opened: unknown[] = []
let workspaceCount = 0

const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))
const emit = (id: string, event: Record<string, unknown>) => {
  for (const listener of listeners) listener({ payload: { id, ...event } })
}
const calls = (command: string) => invoked.filter((c) => c.command === command).map((c) => c.args)

beforeEach(() => {
  invoked = []
  refuseRun = null
  listeners = []
  commands = []
  replies = []
  reported = []
  consoles = []
  opened = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (url.endsWith('/preview') && method === 'POST') {
      opened.push(body)
      return new Response(JSON.stringify({ id: 'p1', workspace: body.workspace, kind: 'site', target: ORIGIN, port: 0, origin: ORIGIN, path: '/', url: `${ORIGIN}/`, console_errors: 0 }))
    }
    if (url.endsWith('/preview/p1/agent') && method === 'GET') {
      const next = commands.shift()
      if (next) return new Response(JSON.stringify(next))
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    if (url.endsWith('/preview/p1/agent')) replies.push(body)
    else if (url.endsWith('/preview/p1/page')) reported.push(String(body.url))
    else if (url.endsWith('/preview/p1/console')) consoles.push(body.entries)
    return new Response(null, { status: 204 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** A page of its own workspace, so one test's view is not another's. */
function page(path = '/cart') {
  const workspace = `/code/site-pages-${++workspaceCount}`
  const p = sitePage(workspace, `${ORIGIN}${path}`)
  if (!p) throw new Error('not a site')
  return { p, workspace, viewId: browserViewId(workspace, ORIGIN) }
}

describe('SitePage', () => {
  it('is one page per workspace and site, and none for a local server', () => {
    const { p, workspace } = page()
    expect(sitePage(workspace, `${ORIGIN}/other`)).toBe(p)
    expect(sitePage('/code/elsewhere', `${ORIGIN}/cart`)).not.toBe(p)
    expect(sitePage(workspace, 'http://localhost:5173/')).toBeNull()
  })

  it('opens its view, registers with the server and reports where the page is', async () => {
    const { p, workspace, viewId } = page()
    const release = p.retain()
    await p.open(`${ORIGIN}/cart`, null)
    await settle()
    expect(calls('browser_view_open')).toEqual([{ id: viewId, url: `${ORIGIN}/cart`, frame: null }])
    expect(opened).toEqual([{ workspace, url: `${ORIGIN}/cart` }])
    expect(p.getState().previewId).toBe('p1')
    expect(reported).toEqual([`${ORIGIN}/cart`])
    emit(viewId, { kind: 'url', url: `${ORIGIN}/checkout` })
    emit('another-view', { kind: 'url', url: 'https://elsewhere.example/' })
    await settle()
    expect(p.getState().url).toBe(`${ORIGIN}/checkout`)
    expect(reported).toEqual([`${ORIGIN}/cart`, `${ORIGIN}/checkout`])
    release()
  })

  it("hands the agent's command to the view and the page's answer to the server", async () => {
    const { p, viewId } = page()
    commands = [{ id: 'c1', command: { action: 'snapshot', site: 'shop.example' } }]
    const release = p.retain()
    await p.open(`${ORIGIN}/cart`, null)
    await settle()
    expect(calls('browser_view_run')).toEqual([{ id: viewId, envelope: { id: 'c1', command: { action: 'snapshot', site: 'shop.example' } } }])
    emit(viewId, {
      kind: 'page',
      url: `${ORIGIN}/cart`,
      messages: [
        { ns: 'openagentd-preview', v: 1, type: 'agent-reply', reply: { id: 'c1', ok: true, result: { text: 'Page: /cart' } } },
        // A reply nobody asked for is not passed on.
        { ns: 'openagentd-preview', v: 1, type: 'agent-reply', reply: { id: 'forged', ok: true, result: { text: 'x' } } },
        { ns: 'openagentd-preview', v: 1, type: 'console', entries: [{ level: 'error', message: 'boom', url: '/cart', ts: 1 }] },
      ],
    })
    await settle()
    expect(replies).toEqual([{ id: 'c1', ok: true, result: { text: 'Page: /cart' } }])
    expect(p.getState().console.map((e) => e.message)).toEqual(['boom'])
    expect(consoles).toHaveLength(1)
    release()
  })

  it('answers for the view when it refuses a command', async () => {
    const { p } = page()
    refuseRun = 'The page is on evil.example now, not shop.example. Take a snapshot to continue there.'
    commands = [{ id: 'c2', command: { action: 'click', ref: 'e1', site: 'shop.example' } }]
    const release = p.retain()
    await p.open(`${ORIGIN}/cart`, null)
    await settle()
    expect(replies).toEqual([{ id: 'c2', ok: false, error: refuseRun }])
    release()
  })

  it('takes a navigation that follows a command for its answer', async () => {
    const { p, viewId } = page()
    commands = [{ id: 'c3', command: { action: 'click', ref: 'e1', site: 'shop.example' } }]
    const release = p.retain()
    await p.open(`${ORIGIN}/cart`, null)
    await settle()
    emit(viewId, { kind: 'load', phase: 'started', url: `${ORIGIN}/paid` })
    emit(viewId, { kind: 'load', phase: 'finished', url: `${ORIGIN}/paid` })
    await settle()
    expect(replies).toEqual([{ id: 'c3', ok: true, result: { text: `Done. The page went to ${ORIGIN}/paid.` } }])
    release()
  })

  it('says so when a page does not load, and keeps the address that was asked for', async () => {
    const { p, viewId } = page('/typo')
    const release = p.retain()
    await p.open(`${ORIGIN}/typo`, null)
    emit(viewId, { kind: 'url', url: `${ORIGIN}/typo`, loading: true })
    expect(p.getState()).toMatchObject({ loading: true, error: null })
    // A view with no address at rest: its first page never arrived.
    emit(viewId, { kind: 'url', url: '', loading: false })
    expect(p.getState()).toMatchObject({ url: `${ORIGIN}/typo`, loading: false, error: 'shop.example could not be loaded. Check the address and your connection.' })
    // The next page that arrives clears it.
    emit(viewId, { kind: 'load', phase: 'started', url: `${ORIGIN}/cart` })
    expect(p.getState()).toMatchObject({ url: `${ORIGIN}/cart`, loading: true, error: null })
    release()
  })

  it('goes back to the page it has when a later address does not load', async () => {
    const { p, viewId } = page()
    const release = p.retain()
    await p.open(`${ORIGIN}/cart`, null)
    emit(viewId, { kind: 'load', phase: 'started', url: `${ORIGIN}/cart` })
    emit(viewId, { kind: 'load', phase: 'finished', url: `${ORIGIN}/cart` })
    emit(viewId, { kind: 'url', url: `${ORIGIN}/cart`, loading: false })
    expect(p.getState()).toMatchObject({ loading: false, error: null })
    await p.open(`${ORIGIN}/gone`, null)
    expect(p.getState()).toMatchObject({ url: `${ORIGIN}/gone`, loading: true })
    // The view is at rest where it was: the address it was sent to never arrived.
    emit(viewId, { kind: 'url', url: `${ORIGIN}/cart`, loading: false })
    expect(p.getState()).toMatchObject({ url: `${ORIGIN}/cart`, loading: false, error: 'shop.example could not be loaded. Check the address and your connection.' })
    release()
  })

  it('does not take a page that arrived while it was being sent for a failure', async () => {
    const { p, viewId } = page()
    const release = p.retain()
    // (The page hears the view from here on.)
    await settle()
    const opening = p.open(`${ORIGIN}/cart`, null)
    emit(viewId, { kind: 'load', phase: 'started', url: `${ORIGIN}/cart` })
    await opening
    emit(viewId, { kind: 'load', phase: 'finished', url: `${ORIGIN}/cart` })
    emit(viewId, { kind: 'url', url: `${ORIGIN}/cart`, loading: false })
    expect(p.getState()).toMatchObject({ loading: false, error: null })
    // An engine that does not say whether it is loading changes only the address.
    emit(viewId, { kind: 'url', url: `${ORIGIN}/cart#top` })
    expect(p.getState()).toMatchObject({ url: `${ORIGIN}/cart#top`, loading: false, error: null })
    release()
  })

  it("goes to an address of its site when the server says the agent opened it", async () => {
    const { p, viewId } = page()
    commands = [
      { id: 'g1', command: { action: 'goto', url: `${ORIGIN}/orders?page=2` } },
      { id: 'g2', command: { action: 'goto', url: 'https://elsewhere.example/' } },
      { id: 'g3', command: { action: 'goto', url: 'http://127.0.0.1:8000/api' } },
    ]
    const release = p.retain()
    await p.open(`${ORIGIN}/cart`, null)
    await settle(30)
    // The page never sees it: the shell navigates.
    expect(calls('browser_view_run')).toEqual([])
    expect(calls('browser_view_open').map((c) => c?.url)).toEqual([`${ORIGIN}/cart`, `${ORIGIN}/orders?page=2`])
    // (g1 answers once the shell took the navigation, after the two refusals.)
    expect([...replies].sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { id: 'g1', ok: true, result: { text: 'Going there.' } },
      { id: 'g2', ok: false, error: 'That address is not a page of this site.' },
      { id: 'g3', ok: false, error: 'That address is not a page of this site.' },
    ])
    // The chat that shows the same open asks again a moment later: one navigation.
    await p.open(`${ORIGIN}/orders?page=2`, null)
    expect(calls('browser_view_open')).toHaveLength(2)
    emit(viewId, { kind: 'title', title: 'Orders' })
    expect(p.getState().title).toBe('Orders')
    release()
  })

  it('moves the view only when its place changes, zoom included', async () => {
    const { p, viewId } = page()
    const release = p.retain()
    const frame = { x: 0.5, y: 0.1, width: 0.5, height: 0.9 }
    await p.open(`${ORIGIN}/cart`, frame)
    p.place({ ...frame })
    p.place({ ...frame, zoom: 1 })
    await settle()
    expect(calls('browser_view_frame')).toEqual([])
    p.place({ ...frame, zoom: 0.5 })
    p.place(null)
    await settle()
    expect(calls('browser_view_frame')).toEqual([{ id: viewId, frame: { ...frame, zoom: 0.5 } }, { id: viewId, frame: null }])
    release()
  })
})
