/**
 * Terminal WebSocket client.
 *
 * Connect flow:
 *   1. POST /api/terminal/ticket (desktop token / access
 *      key attached automatically by installDesktopAuth's fetch patch).
 *   2. Open ws(s)://…/api/terminal/ws?ticket=…&_token=… — the single-use
 *      ticket authorizes the session; `_token` additionally satisfies the
 *      middleware's defence-in-depth WS check when a token is configured.
 *
 * Wire protocol (JSON text frames):
 *   send: {type:'input', data} | {type:'resize', rows, cols}
 *   recv: {type:'output', data} | {type:'exit'}
 */

import { apiUrl } from './base-url'
import { withTokenParam } from './auth'

export interface TerminalSocketCallbacks {
  onOutput: (data: string) => void
  onExit?: () => void
  onError?: (err: Error) => void
  onClose?: () => void
}

export interface TerminalSocket {
  sendInput: (data: string) => void
  sendResize: (rows: number, cols: number) => void
  close: () => void
}

interface TicketResponse {
  ticket: string
  expires_in: number
}

/**
 * The PTY starts at the validated absolute project workspace path.
 */
export type TerminalTarget = { workspace: string }

export async function fetchTerminalTicket(
  target: TerminalTarget,
  rows = 24,
  cols = 80,
): Promise<string> {
  const source = { workspace: target.workspace }
  const res = await fetch(apiUrl('/terminal/ticket'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...source, rows, cols }),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { detail?: string }) => b.detail)
      .catch(() => undefined)
    throw new Error(detail ?? `Terminal ticket failed (${res.status})`)
  }
  const body = (await res.json()) as TicketResponse
  return body.ticket
}

/** Derive the ws(s):// URL for a given /api path from the active base URL. */
export function terminalWsUrl(ticket: string): string {
  const httpUrl = new URL(
    withTokenParam(`${apiUrl('/terminal/ws')}?ticket=${encodeURIComponent(ticket)}`),
    window.location.origin,
  )
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return httpUrl.toString()
}

export async function connectTerminal(
  target: TerminalTarget,
  callbacks: TerminalSocketCallbacks,
  size?: { rows: number; cols: number },
): Promise<TerminalSocket> {
  const ticket = await fetchTerminalTicket(
    target,
    size?.rows ?? 24,
    size?.cols ?? 80,
  )
  const ws = new WebSocket(terminalWsUrl(ticket))

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(event.data) as { type: string; data?: string }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        callbacks.onOutput(msg.data)
      } else if (msg.type === 'exit') {
        callbacks.onExit?.()
      }
    } catch {
      callbacks.onError?.(new Error('Malformed terminal frame'))
    }
  }
  ws.onerror = () => callbacks.onError?.(new Error('Terminal connection error'))
  ws.onclose = () => callbacks.onClose?.()

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    const prevOnClose = ws.onclose
    ws.onclose = (ev) => {
      reject(new Error('Terminal connection refused'))
      prevOnClose?.call(ws, ev)
    }
  })
  // Restore steady-state close handler after successful open.
  ws.onclose = () => callbacks.onClose?.()

  return {
    sendInput: (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    },
    sendResize: (rows: number, cols: number) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', rows, cols }))
      }
    },
    close: () => ws.close(),
  }
}
