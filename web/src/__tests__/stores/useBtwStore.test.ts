import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { setApiBaseUrl } from '@/api/base-url'
import type { SideQuestion } from '@/api/types'
import { mergeLive } from '@/queries/useSideQuestionsQuery'
import { EMPTY_BTW, useBtwStore } from '@/stores/useBtwStore'

const originalFetch = globalThis.fetch

function sse(events: object[], { hold = false }: { hold?: boolean } = {}) {
  const encoder = new TextEncoder()
  let close: () => void = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        const type = (e as { type: string }).type
        controller.enqueue(encoder.encode(`event: ${type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`))
      }
      close = () => controller.close()
      if (!hold) controller.close()
    },
  })
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), close: () => close() }
}

type Call = { url: string; method: string; body: unknown }

function installFetch(handler: (call: Call, signal?: AbortSignal | null) => Response | Promise<Response>) {
  const calls: Call[] = []
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const [input, init] = args as [unknown, RequestInit | undefined]
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    return handler(call, init?.signal)
  }) as unknown as typeof fetch
  return calls
}

const S = 's1'
const state = (sid = S) => useBtwStore.getState().sessions[sid] ?? EMPTY_BTW

beforeEach(() => {
  setApiBaseUrl('')
  useBtwStore.setState({ sessions: {} })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('useBtwStore', () => {
  it('opens the panel and streams the answer into the live exchange', async () => {
    const calls = installFetch(() =>
      sse([
        { type: 'btw_start', id: 'q1', question: 'which file?' },
        { type: 'btw_delta', id: 'q1', text: 'config' },
        { type: 'btw_delta', id: 'q1', text: '.yaml' },
        { type: 'btw_done', id: 'q1', answer: 'config.yaml', model: 'mock:m', usage: null },
      ]).response,
    )
    await useBtwStore.getState().ask(S, 'which file?')

    expect(calls[0]).toEqual({ url: '/api/agent/sessions/s1/btw', method: 'POST', body: { question: 'which file?' } })
    const s = state()
    expect(s.open).toBe(true)
    expect(s.live).toEqual({ id: 'q1', question: 'which file?', text: 'config.yaml', status: 'done', error: null })
    expect(s.revision).toBe(1)
  })

  it('a retry restart clears the text written so far', async () => {
    installFetch(() =>
      sse([
        { type: 'btw_start', id: 'q1', question: 'q' },
        { type: 'btw_delta', id: 'q1', text: 'half' },
        { type: 'btw_start', id: 'q1', question: 'q' },
        { type: 'btw_delta', id: 'q1', text: 'whole' },
      ]).response,
    )
    // No final event: the connection dropped, so the stored row takes over.
    await useBtwStore.getState().ask(S, 'q')
    expect(state().live).toBeNull()
  })

  it('keeps errors and stops with their partial answer', async () => {
    installFetch(() =>
      sse([
        { type: 'btw_start', id: 'q1', question: 'q' },
        { type: 'btw_error', id: 'q1', status: 'error', message: 'rate limited', answer: 'Par' },
      ]).response,
    )
    await useBtwStore.getState().ask(S, 'q')
    expect(state().live).toMatchObject({ status: 'error', error: 'rate limited', text: 'Par' })
  })

  it('shows a refused request as an error', async () => {
    installFetch(() => new Response(JSON.stringify({ detail: 'No provider configured.' }), { status: 400 }))
    await useBtwStore.getState().ask(S, 'q')
    expect(state().live).toMatchObject({ status: 'error', error: expect.stringContaining('No provider configured.') })
  })

  it('stop asks the server and the stream ends stopped', async () => {
    const encoder = new TextEncoder()
    let push: (e: object) => void = () => {}
    let end: () => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (e) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
        end = () => controller.close()
      },
    })
    const calls = installFetch((call) => {
      if (call.url.endsWith('/stop')) {
        // The server ends the open stream with the partial answer.
        push({ type: 'btw_error', id: 'q1', status: 'stopped', message: 'Stopped.', answer: 'Par' })
        end()
        return new Response(null, { status: 204 })
      }
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const asking = useBtwStore.getState().ask(S, 'q')
    await new Promise((r) => setTimeout(r, 0))
    push({ type: 'btw_start', id: 'q1', question: 'q' })
    push({ type: 'btw_delta', id: 'q1', text: 'Par' })
    await new Promise((r) => setTimeout(r, 10))
    expect(state().live).toMatchObject({ id: 'q1', text: 'Par', status: 'streaming' })
    await useBtwStore.getState().stop(S)
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/agent/sessions/s1/btw/q1/stop')).toBe(true)
    await asking
    expect(state().live).toMatchObject({ status: 'stopped', text: 'Par', error: null })
  })

  it('a new ask stops the running one and only the newest writes', async () => {
    const first = sse([{ type: 'btw_start', id: 'q1', question: 'one' }, { type: 'btw_delta', id: 'q1', text: 'old' }], { hold: true })
    const calls = installFetch((call) => {
      if (call.url.endsWith('/stop')) return new Response(null, { status: 204 })
      if ((call.body as { question: string }).question === 'one') return first.response
      return sse([
        { type: 'btw_start', id: 'q2', question: 'two' },
        { type: 'btw_done', id: 'q2', answer: 'new', model: null, usage: null },
      ]).response
    })
    const one = useBtwStore.getState().ask(S, 'one')
    await new Promise((r) => setTimeout(r, 10))
    await useBtwStore.getState().ask(S, 'two')
    first.close()
    await one
    expect(calls.filter((c) => c.url.endsWith('/q1/stop'))).toHaveLength(1)
    expect(state().live).toMatchObject({ id: 'q2', text: 'new', status: 'done' })
  })

  it('dismiss hides, reopen shows the newest, sessions are separate', () => {
    const s = useBtwStore.getState()
    s.reopen(S)
    s.setView(S, 0)
    s.dismiss(S)
    expect(state()).toMatchObject({ open: false, view: 0 })
    s.reopen(S)
    expect(state()).toMatchObject({ open: true, view: null })
    expect(state('other').open).toBe(false)
  })

  it('clear deletes on the server and resets the thread', async () => {
    const calls = installFetch(() => new Response(null, { status: 204 }))
    useBtwStore.setState({ sessions: { [S]: { open: true, view: 2, live: { id: 'q', question: 'q', text: 'a', status: 'done', error: null }, revision: 3 } } })
    await useBtwStore.getState().clear(S)
    expect(calls[0]).toMatchObject({ url: '/api/agent/sessions/s1/btw', method: 'DELETE' })
    expect(state()).toMatchObject({ open: true, view: null, live: null, revision: 4 })
  })
})

describe('mergeLive', () => {
  const row = (id: string, status: SideQuestion['status'], answer = 'stored'): SideQuestion => ({
    id, session_id: S, question: id, answer, status, error: null, model: null, usage: null, created_at: '', updated_at: '',
  })

  it('appends a live answer the list does not have yet', () => {
    const out = mergeLive([row('a', 'done')], { id: null, question: 'new', text: '', status: 'streaming', error: null })
    expect(out.map((e) => [e.key, e.live])).toEqual([['a', false], ['live', true]])
  })

  it('shows the live text over a stored row that is still streaming', () => {
    const out = mergeLive([row('a', 'streaming', '')], { id: 'a', question: 'a', text: 'typing', status: 'streaming', error: null })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ answer: 'typing', live: true })
  })

  it('prefers the stored row once both have ended', () => {
    const out = mergeLive([row('a', 'done', 'final')], { id: 'a', question: 'a', text: 'final', status: 'done', error: null })
    expect(out[0]).toMatchObject({ answer: 'final', live: false })
  })
})
