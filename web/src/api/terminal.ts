/**
 * Terminal WebSocket client.
 *
 * Connect flow:
 *   1. POST /api/terminal/ticket (desktop token / access
 *      key attached automatically by installDesktopAuth's fetch patch).
 *   2. Open ws(s)://…/api/terminal/ws?ticket=…[&proto=2]&_token=… — the
 *      single-use ticket authorizes the session; `_token` additionally
 *      satisfies the middleware's defence-in-depth WS check when a token is
 *      configured.
 *
 * Protocol v2 (the ticket response says `protocol: 2`): shells outlive their
 * socket. Closing the socket only *detaches*; the shell keeps running, its
 * recent output is kept server-side, and a later connection with
 * `session_id` + `since` replays what was missed. Killing is an explicit
 * DELETE (see terminal-sessions.ts).
 *   recv text:   {type:'attached', session_id, seq} (first) | {type:'busy', busy} | {type:'exit'}
 *   recv binary: 8-byte big-endian u64 seq of the payload's first byte + raw PTY bytes
 *   send text:   {type:'input', data} | {type:'resize', rows, cols} | {type:'ack', seq}
 *   close codes: 4409 attached elsewhere, 4429 spawn failed
 *
 * Old protocol (no `protocol` in the ticket response): JSON frames only —
 *   send: {type:'input', data} | {type:'resize', rows, cols}
 *   recv: {type:'output', data} | {type:'exit'} | {type:'busy', busy}
 * and closing the socket kills the shell.
 *
 * `busy` arrives whenever a command starts or stops running in the shell
 * (v3 backends on Unix; it never arrives on Windows), so a terminal with a
 * running command is neither idle-closed nor closed without asking.
 */

import { apiUrl } from './base-url'
import { withTokenParam } from './auth'

/** Ack once this many bytes were processed since the last ack… */
export const TERMINAL_ACK_BYTES = 64 * 1024
/** …and when no further chunk was processed for this long. */
export const TERMINAL_ACK_QUIET_MS = 50

/** WebSocket close code: another window took the session over. */
export const CLOSE_ATTACHED_ELSEWHERE = 4409
/** WebSocket close code: the shell could not be spawned. */
export const CLOSE_SPAWN_FAILED = 4429

const SEQ_HEADER_BYTES = 8

export interface TerminalAttachedInfo {
  sessionId: string
  /** Offset of the first byte that follows. */
  seq: number
}

export interface TerminalSocketCallbacks {
  /** Old protocol: a text chunk of output. */
  onOutput: (data: string) => void
  /**
   * Protocol v2: raw PTY bytes, already de-duplicated. Call `done` once the
   * terminal has processed them — that is what drives the flow-control ack.
   */
  onData?: (bytes: Uint8Array, done: () => void) => void
  /** Protocol v2: older output was dropped before this point (not on a fresh replay). */
  onGap?: () => void
  /** Protocol v2: the offset of the next expected byte moved. */
  onSeq?: (seq: number) => void
  /** Protocol v2: the shell is attached (always the first event). */
  onAttached?: (info: TerminalAttachedInfo) => void
  onExit?: () => void
  /** A command started (true) or finished (false) running in the shell. */
  onBusy?: (busy: boolean) => void
  onError?: (err: Error) => void
  /** The socket closed after a successful connect; `code` is the WebSocket close code. */
  onClose?: (code?: number) => void
}

export interface TerminalSocket {
  sendInput: (data: string) => void
  sendResize: (rows: number, cols: number) => void
  /** v2: detaches (the shell keeps running). Old protocol: kills the shell. */
  close: () => void
  protocol?: 1 | 2
  /** The server-side session id (v2 only). */
  readonly sessionId?: string
}

export interface TerminalConnectOptions {
  /** Reattach to this existing shell (protocol v2). */
  sessionId?: string
  /** Replay output from this byte offset. */
  since?: number
}

/** Why a connect failed, when it matters to the caller. */
export type TerminalConnectErrorKind = 'gone' | 'elsewhere' | 'spawn-failed' | 'failed'

export class TerminalConnectError extends Error {
  readonly kind: TerminalConnectErrorKind
  constructor(message: string, kind: TerminalConnectErrorKind = 'failed') {
    super(message)
    this.name = 'TerminalConnectError'
    this.kind = kind
  }
}

export interface TerminalTicket {
  ticket: string
  expiresIn: number
  protocol: 1 | 2
  sessionId?: string
}

interface TicketResponse {
  ticket: string
  expires_in: number
  protocol?: number
  session_id?: string
}

/**
 * The PTY starts at the validated absolute project workspace path.
 */
export type TerminalTarget = { workspace: string }

export async function requestTerminalTicket(
  target: TerminalTarget,
  rows = 24,
  cols = 80,
  options: TerminalConnectOptions = {},
): Promise<TerminalTicket> {
  const payload: Record<string, unknown> = { workspace: target.workspace, rows, cols }
  if (options.sessionId) {
    payload.session_id = options.sessionId
    if (options.since !== undefined) payload.since = options.since
  }
  const res = await fetch(apiUrl('/terminal/ticket'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { detail?: string }) => b.detail)
      .catch(() => undefined)
    // Asked to reattach and the server no longer has that session.
    if (res.status === 404 && options.sessionId) {
      throw new TerminalConnectError(detail ?? 'Terminal session not found.', 'gone')
    }
    throw new TerminalConnectError(detail ?? `Terminal ticket failed (${res.status})`)
  }
  const body = (await res.json()) as TicketResponse
  return {
    ticket: body.ticket,
    expiresIn: body.expires_in,
    protocol: typeof body.protocol === 'number' && body.protocol >= 2 ? 2 : 1,
    sessionId: body.session_id,
  }
}

export async function fetchTerminalTicket(
  target: TerminalTarget,
  rows = 24,
  cols = 80,
): Promise<string> {
  return (await requestTerminalTicket(target, rows, cols)).ticket
}

/** Derive the ws(s):// URL for a given /api path from the active base URL. */
export function terminalWsUrl(ticket: string, protocol: 1 | 2 = 1): string {
  const proto = protocol === 2 ? '&proto=2' : ''
  const httpUrl = new URL(
    withTokenParam(`${apiUrl('/terminal/ws')}?ticket=${encodeURIComponent(ticket)}${proto}`),
    window.location.origin,
  )
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return httpUrl.toString()
}

/** Route one text frame to its callback; unknown frame types are ignored. */
export function handleTerminalFrame(raw: string, callbacks: TerminalSocketCallbacks): void {
  let msg: { type?: unknown; data?: unknown; busy?: unknown; session_id?: unknown; seq?: unknown }
  try {
    msg = JSON.parse(raw) as typeof msg
  } catch {
    callbacks.onError?.(new Error('Malformed terminal frame'))
    return
  }
  if (msg.type === 'output' && typeof msg.data === 'string') {
    callbacks.onOutput(msg.data)
  } else if (msg.type === 'exit') {
    callbacks.onExit?.()
  } else if (msg.type === 'busy' && typeof msg.busy === 'boolean') {
    callbacks.onBusy?.(msg.busy)
  } else if (msg.type === 'attached' && typeof msg.session_id === 'string') {
    callbacks.onAttached?.({ sessionId: msg.session_id, seq: typeof msg.seq === 'number' ? msg.seq : 0 })
  }
}

/** Split a v2 binary frame into its byte offset and payload; null when malformed. */
export function parseBinaryFrame(
  data: ArrayBuffer | ArrayBufferView,
): { seq: number; payload: Uint8Array } | null {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.byteLength < SEQ_HEADER_BYTES) return null
  const seq = Number(new DataView(bytes.buffer, bytes.byteOffset, SEQ_HEADER_BYTES).getBigUint64(0, false))
  return { seq, payload: bytes.subarray(SEQ_HEADER_BYTES) }
}

function connectError(code: number | undefined): TerminalConnectError {
  if (code === CLOSE_ATTACHED_ELSEWHERE) {
    return new TerminalConnectError('Terminal is open in another window', 'elsewhere')
  }
  if (code === CLOSE_SPAWN_FAILED) {
    return new TerminalConnectError('Could not start the shell', 'spawn-failed')
  }
  return new TerminalConnectError('Terminal connection refused')
}

export async function connectTerminal(
  target: TerminalTarget,
  callbacks: TerminalSocketCallbacks,
  size?: { rows: number; cols: number },
  options: TerminalConnectOptions = {},
): Promise<TerminalSocket> {
  const ticket = await requestTerminalTicket(target, size?.rows ?? 24, size?.cols ?? 80, options)
  const v2 = ticket.protocol === 2
  const ws = new WebSocket(terminalWsUrl(ticket.ticket, ticket.protocol))
  ws.binaryType = 'arraybuffer'

  let sessionId = ticket.sessionId ?? options.sessionId
  // The first byte we expect, and how far the server knows we got.
  let expected = options.since ?? 0
  let quietGap = !options.since // a fresh replay starts wherever the ring starts
  let processedSeq = expected
  let ackedSeq = expected
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  const decoder = new TextDecoder()

  const send = (frame: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  }
  const clearAckTimer = () => {
    if (ackTimer !== null) clearTimeout(ackTimer)
    ackTimer = null
  }
  const sendAck = () => {
    clearAckTimer()
    if (processedSeq <= ackedSeq) return
    ackedSeq = processedSeq
    send({ type: 'ack', seq: ackedSeq })
  }
  /** Xterm finished the bytes up to `end`: ack every ~64 KiB, or once quiet. */
  const noteProcessed = (end: number) => {
    if (end > processedSeq) processedSeq = end
    if (processedSeq - ackedSeq >= TERMINAL_ACK_BYTES) {
      sendAck()
      return
    }
    clearAckTimer()
    ackTimer = setTimeout(sendAck, TERMINAL_ACK_QUIET_MS)
  }

  let settle: { ok: () => void; fail: (err: Error) => void } | null = null
  let settled = false

  const handleBinary = (data: ArrayBuffer | ArrayBufferView) => {
    const frame = parseBinaryFrame(data)
    if (!frame) return
    let { seq, payload } = frame
    if (seq > expected) {
      callbacks.onGap?.()
      expected = seq
    } else if (seq < expected) {
      // Bytes we already have: keep only the part past the overlap.
      const overlap = expected - seq
      if (overlap >= payload.length) return
      payload = payload.subarray(overlap)
      seq = expected
    }
    if (payload.length === 0) return
    const end = seq + payload.length
    expected = end
    callbacks.onSeq?.(end)
    if (callbacks.onData) {
      callbacks.onData(payload, () => noteProcessed(end))
    } else {
      callbacks.onOutput(decoder.decode(payload, { stream: true }))
      noteProcessed(end)
    }
  }

  const routed: TerminalSocketCallbacks = {
    ...callbacks,
    onAttached: (info) => {
      sessionId = info.sessionId
      if (info.seq > expected) {
        if (!quietGap) callbacks.onGap?.()
        expected = info.seq
      }
      quietGap = false
      processedSeq = ackedSeq = expected
      callbacks.onSeq?.(expected)
      callbacks.onAttached?.({ sessionId: info.sessionId, seq: expected })
      settle?.ok()
    },
  }

  ws.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data
    if (typeof data === 'string') {
      handleTerminalFrame(data, routed)
    } else if (v2 && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
      handleBinary(data)
    }
  }
  ws.onerror = () => {
    if (settled) callbacks.onError?.(new Error('Terminal connection error'))
  }

  const socket: TerminalSocket = {
    protocol: ticket.protocol,
    get sessionId() {
      return sessionId
    },
    sendInput: (data: string) => send({ type: 'input', data }),
    sendResize: (rows: number, cols: number) => send({ type: 'resize', rows, cols }),
    close: () => {
      clearAckTimer()
      ws.close()
    },
  }

  await new Promise<void>((resolve, reject) => {
    settle = {
      ok: () => {
        if (settled) return
        settled = true
        resolve()
      },
      fail: (err) => {
        if (settled) return
        settled = true
        reject(err)
      },
    }
    // v2 is connected once the shell is attached; the old protocol on open.
    ws.onopen = () => {
      if (!v2) settle?.ok()
    }
    ws.onclose = (ev?: CloseEvent) => {
      clearAckTimer()
      if (!settled) {
        settle?.fail(connectError(ev?.code))
        return
      }
      callbacks.onClose?.(ev?.code)
    }
  })

  return socket
}
