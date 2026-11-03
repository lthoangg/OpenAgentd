/**
 * Terminal protocol v2 client: binary frames (seq / gap / overlap), ack
 * cadence, the `proto=2` URL, session reattach tickets, and the fallback to
 * the old JSON protocol when the server omits `protocol`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  TERMINAL_ACK_BYTES,
  TERMINAL_ACK_QUIET_MS,
  connectTerminal,
  parseBinaryFrame,
  requestTerminalTicket,
  terminalWsUrl,
  type TerminalSocketCallbacks,
} from '@/api/terminal'
import { useFakeTimers } from '../fake-timers'

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0
  binaryType = 'blob'
  sent: string[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  // test drivers
  serverOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }
  serverText(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  serverBinary(seq: number, payload: number[] | Uint8Array | string) {
    const bytes =
      typeof payload === 'string' ? new TextEncoder().encode(payload) : Uint8Array.from(payload)
    const buf = new ArrayBuffer(8 + bytes.length)
    new DataView(buf).setBigUint64(0, BigInt(seq), false)
    new Uint8Array(buf, 8).set(bytes)
    this.onmessage?.({ data: buf })
  }
  serverClose(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  sentJson() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

const realWebSocket = globalThis.WebSocket
const realFetch = globalThis.fetch
const tick = () => new Promise<void>((r) => setImmediate(r))
const fn = (impl: (...args: never[]) => unknown) => mock(impl as unknown as (...args: unknown[]) => unknown)

let ticketBody: Record<string, unknown>
let ticketStatus: number
let ticketRequests: Array<Record<string, unknown>>

beforeEach(() => {
  FakeWebSocket.instances = []
  ticketRequests = []
  ticketStatus = 200
  ticketBody = { ticket: 'tkt', expires_in: 30, protocol: 2 }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  globalThis.fetch = fn(async (_url: string, init?: RequestInit) => {
    ticketRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify(ticketBody), { status: ticketStatus })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.WebSocket = realWebSocket
  globalThis.fetch = realFetch
})

function callbacks() {
  const chunks: Array<{ bytes: Uint8Array; done: () => void }> = []
  const cb = {
    onOutput: fn((_d: string) => {}),
    onData: fn((bytes: Uint8Array, done: () => void) => {
      chunks.push({ bytes, done })
    }),
    onGap: fn(() => {}),
    onSeq: fn((_s: number) => {}),
    onAttached: fn((_a: { sessionId: string; seq: number }) => {}),
    onExit: fn(() => {}),
    onBusy: fn((_b: boolean) => {}),
    onError: fn((_e: Error) => {}),
    onClose: fn((_c?: number) => {}),
  }
  return { cb: cb as unknown as TerminalSocketCallbacks & typeof cb, chunks }
}

/** Connect over the fake socket and finish the v2 handshake. */
async function attach(
  cb: TerminalSocketCallbacks,
  options?: { sessionId?: string; since?: number },
  attached: { session_id?: string; seq?: number } = {},
) {
  const pending = connectTerminal({ workspace: '/ws' }, cb, { rows: 30, cols: 100 }, options)
  await tick()
  const ws = FakeWebSocket.instances[0]
  ws.serverOpen()
  ws.serverText({ type: 'attached', session_id: attached.session_id ?? 'sess-1', seq: attached.seq ?? 0 })
  const socket = await pending
  return { ws, socket }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('terminalWsUrl', () => {
  it('adds proto=2 only for protocol 2', () => {
    expect(terminalWsUrl('t', 2)).toContain('proto=2')
    expect(terminalWsUrl('t', 1)).not.toContain('proto')
    expect(terminalWsUrl('t')).not.toContain('proto')
    expect(terminalWsUrl('t', 2)).toContain('ticket=t')
  })
})

describe('requestTerminalTicket', () => {
  it('sends session_id and since for a reattach and reads protocol + session_id', async () => {
    ticketBody = { ticket: 'tkt', expires_in: 30, protocol: 2, session_id: 'sess-9' }
    const t = await requestTerminalTicket({ workspace: '/ws' }, 30, 100, {
      sessionId: 'sess-9',
      since: 1234,
    })
    expect(ticketRequests[0]).toEqual({
      workspace: '/ws',
      rows: 30,
      cols: 100,
      session_id: 'sess-9',
      since: 1234,
    })
    expect(t).toEqual({ ticket: 'tkt', expiresIn: 30, protocol: 2, sessionId: 'sess-9' })
  })

  it('omits session_id and since for a new shell', async () => {
    await requestTerminalTicket({ workspace: '/ws' }, 24, 80)
    expect(ticketRequests[0]).toEqual({ workspace: '/ws', rows: 24, cols: 80 })
  })

  it('treats a missing protocol as the old protocol', async () => {
    ticketBody = { ticket: 'tkt', expires_in: 30 }
    expect((await requestTerminalTicket({ workspace: '/ws' })).protocol).toBe(1)
  })

  it('a 404 for a reattach means the session is gone', async () => {
    ticketStatus = 404
    ticketBody = { detail: 'Terminal session not found.' }
    await expect(
      requestTerminalTicket({ workspace: '/ws' }, 24, 80, { sessionId: 'sess-9', since: 0 }),
    ).rejects.toMatchObject({ kind: 'gone', message: 'Terminal session not found.' })
  })
})

describe('parseBinaryFrame', () => {
  it('reads the big-endian u64 seq and the payload', () => {
    const buf = new ArrayBuffer(11)
    new DataView(buf).setBigUint64(0, 0x0102030405n, false)
    new Uint8Array(buf, 8).set([7, 8, 9])
    const frame = parseBinaryFrame(buf)!
    expect(frame.seq).toBe(0x0102030405)
    expect([...frame.payload]).toEqual([7, 8, 9])
  })

  it('rejects frames shorter than the header', () => {
    expect(parseBinaryFrame(new ArrayBuffer(7))).toBeNull()
  })
})

describe('connectTerminal protocol v2', () => {
  it('opens proto=2 with an arraybuffer socket and resolves on attached', async () => {
    const { cb } = callbacks()
    const { ws, socket } = await attach(cb, undefined, { session_id: 'sess-42', seq: 0 })
    expect(ws.url).toContain('/api/terminal/ws')
    expect(ws.url).toContain('ticket=tkt')
    expect(ws.url).toContain('proto=2')
    expect(ws.binaryType).toBe('arraybuffer')
    expect(socket.protocol).toBe(2)
    expect(socket.sessionId).toBe('sess-42')
    expect(cb.onAttached).toHaveBeenCalledWith({ sessionId: 'sess-42', seq: 0 })
    expect(ticketRequests[0]).toEqual({ workspace: '/ws', rows: 30, cols: 100 })
  })

  it('does not resolve before the attached frame', async () => {
    const { cb } = callbacks()
    const pending = connectTerminal({ workspace: '/ws' }, cb)
    let settled = false
    void pending.then(() => (settled = true))
    await tick()
    FakeWebSocket.instances[0].serverOpen()
    await tick()
    expect(settled).toBe(false)
    FakeWebSocket.instances[0].serverText({ type: 'attached', session_id: 's', seq: 0 })
    await pending
    expect(settled).toBe(true)
  })

  it('delivers binary payloads in order with raw bytes', async () => {
    const { cb, chunks } = callbacks()
    const { ws } = await attach(cb)
    ws.serverBinary(0, 'héllo')
    const first = chunks[0].bytes
    expect(new TextDecoder().decode(first)).toBe('héllo')
    ws.serverBinary(first.length, [0x21])
    expect(chunks).toHaveLength(2)
    expect(cb.onSeq).toHaveBeenLastCalledWith(first.length + 1)
    expect(cb.onGap).not.toHaveBeenCalled()
  })

  it('a seq above the expected one is a gap when not on a fresh replay', async () => {
    const { cb, chunks } = callbacks()
    const { ws } = await attach(cb, { sessionId: 'sess-1', since: 10 }, { seq: 10 })
    ws.serverBinary(10, 'ab')
    expect(cb.onGap).not.toHaveBeenCalled()
    ws.serverBinary(500, 'cd')
    expect(cb.onGap).toHaveBeenCalledTimes(1)
    expect(chunks).toHaveLength(2)
    expect(cb.onSeq).toHaveBeenLastCalledWith(502)
  })

  it('a gap at the start of a fresh replay (since=0) is silent, later gaps are not', async () => {
    const { cb, chunks } = callbacks()
    const { ws } = await attach(cb, { sessionId: 'sess-1', since: 0 }, { seq: 4096 })
    ws.serverBinary(4096, 'ab')
    expect(cb.onGap).not.toHaveBeenCalled()
    expect(chunks).toHaveLength(1)
    ws.serverBinary(9000, 'zz')
    expect(cb.onGap).toHaveBeenCalledTimes(1)
  })

  it('an attached seq above the requested since is a gap on a non-fresh reattach', async () => {
    const { cb } = callbacks()
    await attach(cb, { sessionId: 'sess-1', since: 100 }, { seq: 900 })
    expect(cb.onGap).toHaveBeenCalledTimes(1)
    expect(cb.onSeq).toHaveBeenLastCalledWith(900)
  })

  it('skips duplicated bytes when a frame overlaps what was already seen', async () => {
    const { cb, chunks } = callbacks()
    const { ws } = await attach(cb)
    ws.serverBinary(0, 'abcd')
    ws.serverBinary(2, 'cdef') // 'cd' already seen
    expect(new TextDecoder().decode(chunks[1].bytes)).toBe('ef')
    ws.serverBinary(0, 'abcdef') // entirely duplicated
    expect(chunks).toHaveLength(2)
    expect(cb.onSeq).toHaveBeenLastCalledWith(6)
    expect(cb.onGap).not.toHaveBeenCalled()
  })

  it('acks the seq just past processed bytes once ~64 KiB is processed', async () => {
    const { cb, chunks } = callbacks()
    const { ws } = await attach(cb)
    const big = new Uint8Array(TERMINAL_ACK_BYTES).fill(65)
    ws.serverBinary(0, big)
    // Nothing is acked until xterm has processed the bytes.
    expect(ws.sentJson()).toEqual([])
    chunks[0].done()
    expect(ws.sentJson()).toEqual([{ type: 'ack', seq: TERMINAL_ACK_BYTES }])
  })

  it('acks small amounts once the stream goes quiet, not on every chunk', async () => {
    const timers = useFakeTimers()
    try {
      const { cb, chunks } = callbacks()
      const { ws } = await attach(cb)
      ws.serverBinary(0, 'abc')
      ws.serverBinary(3, 'def')
      chunks[0].done()
      chunks[1].done()
      expect(ws.sentJson()).toEqual([])
      timers.tick(TERMINAL_ACK_QUIET_MS - 1)
      expect(ws.sentJson()).toEqual([])
      timers.tick(1)
      expect(ws.sentJson()).toEqual([{ type: 'ack', seq: 6 }])
      // No further ack without new processed bytes.
      timers.tick(10_000)
      expect(ws.sentJson()).toHaveLength(1)
    } finally {
      timers.restore()
    }
  })

  it('acks at most once per 64 KiB while data keeps flowing', async () => {
    const timers = useFakeTimers()
    try {
      const { cb, chunks } = callbacks()
      const { ws } = await attach(cb)
      const half = new Uint8Array(TERMINAL_ACK_BYTES / 2).fill(66)
      ws.serverBinary(0, half)
      ws.serverBinary(half.length, half)
      ws.serverBinary(half.length * 2, half)
      chunks.forEach((c) => c.done())
      // First two chunks reached 64 KiB → one ack; the third waits for quiet.
      expect(ws.sentJson()).toEqual([{ type: 'ack', seq: TERMINAL_ACK_BYTES }])
      timers.tick(TERMINAL_ACK_QUIET_MS)
      expect(ws.sentJson().at(-1)).toEqual({ type: 'ack', seq: TERMINAL_ACK_BYTES * 1.5 })
    } finally {
      timers.restore()
    }
  })

  it('sends input and resize as JSON text frames', async () => {
    const { cb } = callbacks()
    const { ws, socket } = await attach(cb)
    socket.sendInput('ls\r')
    socket.sendResize(40, 120)
    expect(ws.sentJson()).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', rows: 40, cols: 120 },
    ])
  })

  it('routes busy and exit control frames', async () => {
    const { cb } = callbacks()
    const { ws } = await attach(cb)
    ws.serverText({ type: 'busy', busy: true })
    ws.serverText({ type: 'exit' })
    expect(cb.onBusy).toHaveBeenCalledWith(true)
    expect(cb.onExit).toHaveBeenCalledTimes(1)
  })

  it('reports the close code after the session was attached', async () => {
    const { cb } = callbacks()
    const { ws } = await attach(cb)
    ws.serverClose(4409)
    expect(cb.onClose).toHaveBeenCalledWith(4409)
  })

  it('closing the socket only detaches: no kill traffic, ack timer cleared', async () => {
    const timers = useFakeTimers()
    try {
      const { cb, chunks } = callbacks()
      const { ws, socket } = await attach(cb)
      ws.serverBinary(0, 'abc')
      chunks[0].done()
      socket.close()
      expect(ws.closed).toBe(true)
      timers.tick(10_000)
      expect(ws.sentJson()).toEqual([])
    } finally {
      timers.restore()
    }
  })

  it('rejects with kind "elsewhere" on 4409 during the handshake', async () => {
    const { cb } = callbacks()
    const pending = connectTerminal({ workspace: '/ws' }, cb, undefined, { sessionId: 's', since: 0 })
    await tick()
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    ws.serverClose(4409)
    await expect(pending).rejects.toMatchObject({ kind: 'elsewhere' })
    expect(cb.onClose).not.toHaveBeenCalled()
  })

  it('rejects with kind "spawn-failed" on 4429', async () => {
    const { cb } = callbacks()
    const pending = connectTerminal({ workspace: '/ws' }, cb)
    await tick()
    FakeWebSocket.instances[0].serverClose(4429)
    await expect(pending).rejects.toMatchObject({ kind: 'spawn-failed' })
  })

  it('rejects with kind "gone" when the reattach ticket 404s', async () => {
    ticketStatus = 404
    ticketBody = { detail: 'Terminal session not found.' }
    const { cb } = callbacks()
    await expect(
      connectTerminal({ workspace: '/ws' }, cb, undefined, { sessionId: 'gone', since: 5 }),
    ).rejects.toMatchObject({ kind: 'gone' })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('connectTerminal old protocol fallback', () => {
  beforeEach(() => {
    ticketBody = { ticket: 'tkt', expires_in: 30 } // no `protocol`
  })

  it('uses no proto param, resolves on open, and speaks JSON output frames', async () => {
    const { cb } = callbacks()
    const pending = connectTerminal({ workspace: '/ws' }, cb)
    await tick()
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).not.toContain('proto')
    ws.serverOpen()
    const socket = await pending
    expect(socket.protocol).toBe(1)
    expect(socket.sessionId).toBeUndefined()

    ws.serverText({ type: 'output', data: 'hi' })
    ws.serverText({ type: 'busy', busy: true })
    ws.serverText({ type: 'exit' })
    expect(cb.onOutput).toHaveBeenCalledWith('hi')
    expect(cb.onBusy).toHaveBeenCalledWith(true)
    expect(cb.onExit).toHaveBeenCalledTimes(1)
    expect(cb.onData).not.toHaveBeenCalled()

    socket.sendInput('x')
    expect(ws.sentJson()).toEqual([{ type: 'input', data: 'x' }])
    ws.serverClose(1006)
    expect(cb.onClose).toHaveBeenCalledWith(1006)
  })

  it('never sends acks', async () => {
    const { cb } = callbacks()
    const pending = connectTerminal({ workspace: '/ws' }, cb)
    await tick()
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    await pending
    ws.serverText({ type: 'output', data: 'a'.repeat(200_000) })
    expect(ws.sentJson()).toEqual([])
  })
})
