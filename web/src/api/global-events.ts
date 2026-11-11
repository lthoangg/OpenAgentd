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
  'session_activity',
  'title_update',
  'desktop_notification',
  'subagent_spawned',
  'subagent_status',
  'workspace_files_changed',
  'config_changed',
  'mcp_status_changed',
  'lsp_install_required',
  'session_goal',
  // Starts every stream: where it resumes from (see `globalEventStream`).
  'stream_resume',
  // Session streams carried on this feed; the stream hub consumes them.
  'session_event',
  'session_stream_end',
] as const

export type GlobalEventType = (typeof GLOBAL_EVENT_TYPES)[number]

export interface GlobalEventCallbacks extends SSECallbacks {
  onOpen?: () => void
}

/**
 * Where this app last was on a server's feed: the id of the last event it
 * read. Reopening the feed with it (`?since=`) replays what was published
 * meanwhile (a phone in the background, a laptop asleep, a dropped relay).
 * In localStorage, keyed by server: every window of the app shares it (one
 * of them reads the feed for all, and another may take over), and it
 * outlives a reload. A server that cannot serve it says so in
 * `stream_resume` and the app refreshes everything, as on a first open.
 */
const CURSOR_PREFIX = 'oa-global-stream-cursor:'

function cursorKey(): string {
  return `${CURSOR_PREFIX}${apiBaseUrl()}`
}

export function readGlobalStreamCursor(): string | null {
  try {
    const cursor = window.localStorage.getItem(cursorKey())
    return cursor && /^[A-Za-z0-9-]{3,40}$/.test(cursor) ? cursor : null
  } catch {
    return null
  }
}

function saveCursor(id: string): void {
  try {
    window.localStorage.setItem(cursorKey(), id)
  } catch {
    // Storage full or blocked: the next reconnect refreshes everything.
  }
}

/** Open the app-lifetime event feed used by first-party clients. */
export function globalEventStream(callbacks: GlobalEventCallbacks, signal?: AbortSignal, clientId?: string): void {
  // With a client id the feed also carries the session streams subscribed
  // through `putStreamSubscriptions` (see `stream-hub.ts`).
  const params = new URLSearchParams()
  if (clientId) params.set('client_id', clientId)
  const since = readGlobalStreamCursor()
  if (since) params.set('since', since)
  const query = params.toString()
  const url = `${apiBaseUrl()}/events/stream${query ? `?${query}` : ''}`
  const tracked: SSECallbacks = {
    ...callbacks,
    onEvent: (type, data, id) => {
      // After the event is handled: a drop while handling it replays it.
      callbacks.onEvent(type, data, id)
      if (id) saveCursor(id)
    },
  }
  fetch(url, { signal, headers: apiAuthHeaders(url) })
    .then((res) => {
      if (!res.ok) throw new Error(`GET /events/stream failed: ${res.status}`)
      callbacks.onOpen?.()
      readSSE(res, tracked)
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
