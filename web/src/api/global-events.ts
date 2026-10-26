import { apiBaseUrl } from './base-url'
import { apiAuthHeaders } from './auth'
import { readSSE } from './sse'
import type { SSECallbacks } from './sse'

/**
 * Events on the app-lifetime feed (`/events/stream`). Must match
 * `global_stream` in `appv3/crates/agent/data/sse_events.json` (enforced by
 * `sse-contract.test.ts`).
 */
export const GLOBAL_EVENT_TYPES = [
  'session_turn_started',
  'session_turn_completed',
  'title_update',
  'desktop_notification',
  'subagent_spawned',
  'subagent_status',
  'workspace_files_changed',
  'config_changed',
  'mcp_status_changed',
  'lsp_install_required',
  'session_goal',
  // Session streams carried on this feed; the stream hub consumes them.
  'session_event',
  'session_stream_end',
] as const

export type GlobalEventType = (typeof GLOBAL_EVENT_TYPES)[number]

export interface GlobalEventCallbacks extends SSECallbacks {
  onOpen?: () => void
}

/** Open the app-lifetime event feed used by first-party clients. */
export function globalEventStream(callbacks: GlobalEventCallbacks, signal?: AbortSignal, clientId?: string): void {
  // With a client id the feed also carries the session streams subscribed
  // through `putStreamSubscriptions` (see `stream-hub.ts`).
  const url = `${apiBaseUrl()}/events/stream${clientId ? `?client_id=${encodeURIComponent(clientId)}` : ''}`
  fetch(url, { signal, headers: apiAuthHeaders(url) })
    .then((res) => {
      if (!res.ok) throw new Error(`GET /events/stream failed: ${res.status}`)
      callbacks.onOpen?.()
      readSSE(res, callbacks)
    })
    .catch((err) => { if (err.name !== 'AbortError') callbacks.onError?.(err) })
}

export interface StreamSubscription {
  id: string
  session_id: string
}

/**
 * Replace the sessions the feed opened with `clientId` carries. `gone` means
 * the server no longer has that feed open, so it must be reopened.
 */
export async function putStreamSubscriptions(
  clientId: string,
  subs: StreamSubscription[],
  signal?: AbortSignal,
): Promise<'ok' | 'gone' | 'error'> {
  const url = `${apiBaseUrl()}/events/subscriptions/${encodeURIComponent(clientId)}`
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders(url) },
      body: JSON.stringify({ subs }),
      signal,
    })
    if (res.ok) return 'ok'
    return res.status === 404 ? 'gone' : 'error'
  } catch {
    return 'error'
  }
}
