import { apiBaseUrl } from './base-url'
import { globalEventStream, putStreamSubscriptions } from './global-events'
import type { GlobalEventCallbacks, StreamSubscription } from './global-events'
import type { SSECallbacks } from './sse'

/**
 * One connection to the backend for every window of the app.
 *
 * A webview opens at most 6 HTTP/1.1 connections per host, shared by all its
 * windows. Giving each window a global stream plus a stream per running
 * session used them all up with three busy windows; every later request
 * (approve a plan, stop, load the session list, git status) then queued
 * behind them with no error and no timeout.
 *
 * The window holding the Web Lock for the backend (the leader) opens
 * `GET /events/stream?client_id=…`, which carries the global events and, on
 * request (`PUT /events/subscriptions/…`), the session streams of every
 * window. The leader hands each frame to the window it belongs to over a
 * BroadcastChannel; the other windows only listen.
 *
 * Each session subscription is bound to the leader's `gen` (its client id).
 * When the leader changes, a window's bound subscriptions are failed with a
 * transient error: the session store reconnects and subscribes again, and
 * the server replays the turn on that attach exactly as it does for a
 * dropped per-session stream.
 */

type SharedMessage =
  | { t: 'hello'; w: string }
  | { t: 'open'; gen: string; to?: string }
  | { t: 'nomux' }
  | { t: 'ev'; type: string; data: unknown }
  | { t: 'sub'; w: string; id: string; sid: string; gen: string }
  | { t: 'unsub'; id: string }
  | { t: 'bye'; w: string }

/** Leader → one window: a frame of one of its subscriptions. */
type WindowMessage = { t: 's'; id: string; type: string; data: unknown } | { t: 'e'; id: string }

export interface ChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: SharedMessage | WindowMessage): void
  close(): void
}

export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>
}

export interface HubDeps {
  locks: LockManagerLike
  makeChannel: (name: string) => ChannelLike
  /** Open the feed; `clientId` is null when the server cannot carry sessions. */
  openStream: (clientId: string | null, callbacks: GlobalEventCallbacks, signal: AbortSignal) => void
  /** Must answer `error` once `signal` aborts. */
  putSubscriptions: (clientId: string, subs: StreamSubscription[], signal?: AbortSignal) => Promise<'ok' | 'gone' | 'error'>
  /** Identifies the backend; windows pointed at different backends never share. */
  key: string
  windowId: string
  newId: () => string
  /** How long a subscription request may take; defaults to `PUT_TIMEOUT_MS`. */
  putTimeoutMs?: number
}

interface Sub {
  id: string
  sid: string
  callbacks: SSECallbacks
  /** The leader this subscription was sent to; null until it is. */
  gen: string | null
}

const NAME_PREFIX = 'openagentd-stream:'

/**
 * Subscription requests go out one at a time, so one that never answers
 * (queued behind the webview's per-host connection limit, which has no
 * timeout of its own) would leave every later subscription unsent: the
 * chat then shows nothing until a reload. Past this, the feed restarts.
 */
export const PUT_TIMEOUT_MS = 10_000

/** Reads as a dropped connection, which the session store reconnects from. */
const restarted = () => new Error('Connection closed: the shared event stream restarted')

export class StreamHub {
  private readonly deps: HubDeps
  private readonly name: string
  private readonly globals = new Set<GlobalEventCallbacks>()
  private readonly subs = new Map<string, Sub>()
  private shared: ChannelLike | null = null
  private own: ChannelLike | null = null
  private onPageHide: (() => void) | null = null
  private election: AbortController | null = null
  private release: (() => void) | null = null
  private tearingDown = false
  private counter = 0
  /** null until the server has shown whether it carries session streams. */
  muxSupported: boolean | null = null
  // Leader.
  private leading = false
  private gen: string | null = null
  private ready = false
  private proven = false
  private mux: AbortController | null = null
  private readonly remote = new Map<string, { w: string; sid: string }>()
  private readonly targets = new Map<string, ChannelLike>()
  private syncing = false
  private dirty = false
  private sent = ''
  // Follower.
  private knownGen: string | null = null

  constructor(deps: HubDeps) {
    this.deps = deps
    this.name = `${NAME_PREFIX}${deps.key}`
  }

  // ── consumers ────────────────────────────────────────────────────────────

  subscribeGlobal(callbacks: GlobalEventCallbacks, signal?: AbortSignal): void {
    if (signal?.aborted) return
    this.globals.add(callbacks)
    this.engage()
    if (this.leading) {
      // Already open: tell this consumer without reopening anything.
      if (this.ready) queueMicrotask(() => { if (this.globals.has(callbacks)) callbacks.onOpen?.() })
    } else {
      this.post({ t: 'hello', w: this.deps.windowId })
    }
    signal?.addEventListener('abort', () => {
      this.globals.delete(callbacks)
      this.idle()
    }, { once: true })
  }

  subscribeSession(sessionId: string, callbacks: SSECallbacks, signal?: AbortSignal): void {
    if (signal?.aborted) return
    const id = `${this.deps.windowId}-${++this.counter}`
    const sub: Sub = { id, sid: sessionId, callbacks, gen: null }
    this.subs.set(id, sub)
    this.engage()
    if (this.leading) {
      if (this.ready) {
        sub.gen = this.gen
        this.scheduleSync()
      }
    } else if (this.knownGen !== null) {
      sub.gen = this.knownGen
      this.post({ t: 'sub', w: this.deps.windowId, id, sid: sessionId, gen: this.knownGen })
    } else {
      this.post({ t: 'hello', w: this.deps.windowId })
    }
    signal?.addEventListener('abort', () => this.drop(id), { once: true })
  }

  private drop(id: string): void {
    const sub = this.subs.get(id)
    if (!sub) return
    this.subs.delete(id)
    if (this.leading) this.scheduleSync()
    else if (sub.gen !== null) this.post({ t: 'unsub', id })
    this.idle()
  }

  private consumers(): number {
    return this.globals.size + this.subs.size
  }

  /** A window that reconnects aborts and resubscribes in one tick: wait it out. */
  private idle(): void {
    if (this.consumers() > 0 || this.tearingDown) return
    this.tearingDown = true
    queueMicrotask(() => {
      this.tearingDown = false
      if (this.consumers() === 0) this.teardown()
    })
  }

  private teardown(): void {
    if (this.leading) {
      this.mux?.abort()
      this.stepDown()
    }
    this.election?.abort()
    this.election = null
    this.post({ t: 'bye', w: this.deps.windowId })
    if (this.onPageHide && typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide)
    this.onPageHide = null
    this.shared?.close()
    this.own?.close()
    this.shared = null
    this.own = null
    this.knownGen = null
  }

  // ── channels ─────────────────────────────────────────────────────────────

  private engage(): void {
    if (!this.shared) {
      this.shared = this.deps.makeChannel(this.name)
      this.shared.onmessage = (event) => this.onShared(event.data as SharedMessage)
      this.own = this.deps.makeChannel(`${this.name}:${this.deps.windowId}`)
      this.own.onmessage = (event) => this.onOwn(event.data as WindowMessage)
      if (typeof window !== 'undefined') {
        this.onPageHide = () => this.post({ t: 'bye', w: this.deps.windowId })
        window.addEventListener('pagehide', this.onPageHide)
      }
    }
    if (!this.election) this.startElection()
  }

  private post(message: SharedMessage): void {
    try {
      this.shared?.postMessage(message)
    } catch {
      // A closed channel has no listeners left to tell.
    }
  }

  private target(w: string): ChannelLike {
    let channel = this.targets.get(w)
    if (!channel) {
      channel = this.deps.makeChannel(`${this.name}:${w}`)
      this.targets.set(w, channel)
    }
    return channel
  }

  private tell(w: string, message: WindowMessage): void {
    try {
      this.target(w).postMessage(message)
    } catch {
      // The window is gone.
    }
  }

  // ── election ─────────────────────────────────────────────────────────────

  private startElection(): void {
    const controller = new AbortController()
    this.election = controller
    void this.deps.locks
      .request(this.name, { signal: controller.signal }, () => new Promise<void>((resolve) => {
        this.release = resolve
        this.lead()
      }))
      // Aborted while still waiting for the lock.
      .catch(() => undefined)
      .finally(() => { if (this.election === controller) this.election = null })
  }

  private lead(): void {
    this.leading = true
    this.gen = this.deps.newId()
    this.ready = false
    this.proven = false
    this.sent = ''
    this.knownGen = null
    // What was sent to the previous leader is not carried over.
    for (const sub of [...this.subs.values()]) if (sub.gen !== null) this.fail(sub)
    this.openMux()
  }

  private stepDown(): void {
    this.leading = false
    this.ready = false
    this.gen = null
    this.mux = null
    this.dirty = false
    this.sent = ''
    this.remote.clear()
    for (const channel of this.targets.values()) channel.close()
    this.targets.clear()
    const release = this.release
    this.release = null
    this.election = null
    release?.()
  }

  private openMux(): void {
    const controller = new AbortController()
    this.mux = controller
    const gen = this.gen as string
    this.deps.openStream(
      this.muxSupported === false ? null : gen,
      {
        onOpen: () => {
          if (this.mux !== controller) return
          this.ready = true
          this.post({ t: 'open', gen })
          for (const sub of this.subs.values()) if (sub.gen === null) sub.gen = gen
          for (const g of [...this.globals]) g.onOpen?.()
          this.scheduleSync()
        },
        onEvent: (type, data) => {
          if (this.mux === controller) this.onFrame(type, data)
        },
        onParseError: (error) => { for (const g of this.globals) g.onParseError?.(error) },
        onError: (error) => this.muxDown(controller, error),
        onDone: () => this.muxDown(controller, null),
      },
      controller.signal,
    )
  }

  /** The feed ended: every subscription on it is lost, and so is leadership. */
  private muxDown(controller: AbortController, error: Error | null): void {
    if (this.mux !== controller) return
    controller.abort()
    for (const sub of [...this.subs.values()]) this.fail(sub)
    this.stepDown()
    for (const g of [...this.globals]) {
      if (error) g.onError?.(error)
      else g.onDone?.()
    }
    this.idle()
  }

  private fail(sub: Sub): void {
    this.subs.delete(sub.id)
    sub.callbacks.onError?.(restarted())
  }

  // ── leader: frames in ────────────────────────────────────────────────────

  private onFrame(type: string, data: unknown): void {
    if (type === 'session_event') {
      const frame = data as { sub_id?: unknown; type?: unknown; data?: unknown }
      if (typeof frame.sub_id === 'string' && typeof frame.type === 'string') this.route(frame.sub_id, frame.type, frame.data)
      return
    }
    if (type === 'session_stream_end') {
      const id = (data as { sub_id?: unknown }).sub_id
      if (typeof id === 'string') this.endSub(id)
      return
    }
    for (const g of [...this.globals]) g.onEvent(type, data)
    this.post({ t: 'ev', type, data })
  }

  private route(id: string, type: string, data: unknown): void {
    const local = this.subs.get(id)
    if (local) {
      local.callbacks.onEvent(type, data)
      return
    }
    const remote = this.remote.get(id)
    if (remote) this.tell(remote.w, { t: 's', id, type, data })
  }

  private endSub(id: string): void {
    const local = this.subs.get(id)
    if (local) {
      this.subs.delete(id)
      local.callbacks.onDone?.()
    } else {
      const remote = this.remote.get(id)
      if (!remote) return
      this.remote.delete(id)
      this.tell(remote.w, { t: 'e', id })
    }
    this.scheduleSync()
  }

  // ── leader: subscriptions out ────────────────────────────────────────────

  private wanted(): StreamSubscription[] {
    const out: StreamSubscription[] = []
    for (const sub of this.subs.values()) if (sub.gen === this.gen) out.push({ id: sub.id, session_id: sub.sid })
    for (const [id, r] of this.remote) out.push({ id, session_id: r.sid })
    return out
  }

  /** Sends the full set, one request at a time and only when it changed. */
  private scheduleSync(): void {
    if (!this.ready || this.muxSupported === false) return
    this.dirty = true
    if (this.syncing) return
    this.syncing = true
    const controller = this.mux
    void (async () => {
      try {
        while (this.dirty && controller && this.mux === controller) {
          this.dirty = false
          const wanted = this.wanted()
          const signature = wanted.map((s) => s.id).sort().join(',')
          if (signature === this.sent) continue
          const timeout = new AbortController()
          const timer = setTimeout(() => timeout.abort(), this.deps.putTimeoutMs ?? PUT_TIMEOUT_MS)
          let result: 'ok' | 'gone' | 'error'
          try {
            result = await this.deps.putSubscriptions(this.gen as string, wanted, timeout.signal)
          } finally {
            clearTimeout(timer)
          }
          if (this.mux !== controller) return
          if (timeout.signal.aborted && result !== 'ok') {
            console.warn(`[stream-hub] subscription request timed out; restarting the shared feed (${wanted.length} sessions)`)
          }
          if (result === 'ok') {
            this.proven = true
            this.sent = signature
          } else if (result === 'gone' && !this.proven && this.muxSupported === null) {
            // The server answered 404 to a feed it just opened: an older
            // server that serves the global feed but not sessions on it.
            this.unsupported()
            return
          } else {
            this.muxDown(controller, new Error('Connection closed: could not subscribe to sessions'))
            return
          }
        }
      } finally {
        this.syncing = false
      }
    })()
  }

  private unsupported(): void {
    this.muxSupported = false
    this.post({ t: 'nomux' })
    for (const sub of [...this.subs.values()]) this.fail(sub)
    this.remote.clear()
    this.idle()
  }

  // ── messages ─────────────────────────────────────────────────────────────

  private onShared(m: SharedMessage): void {
    if (!m || typeof m !== 'object') return
    if (this.leading) {
      if (m.t === 'hello') {
        if (this.muxSupported === false) this.post({ t: 'nomux' })
        if (this.ready) this.post({ t: 'open', gen: this.gen as string, to: m.w })
      } else if (m.t === 'sub') {
        if (this.ready && m.gen === this.gen && this.muxSupported !== false) {
          this.remote.set(m.id, { w: m.w, sid: m.sid })
          this.scheduleSync()
        }
      } else if (m.t === 'unsub') {
        if (this.remote.delete(m.id)) this.scheduleSync()
      } else if (m.t === 'bye') {
        let changed = false
        for (const [id, r] of this.remote) {
          if (r.w !== m.w) continue
          this.remote.delete(id)
          changed = true
        }
        this.targets.get(m.w)?.close()
        this.targets.delete(m.w)
        if (changed) this.scheduleSync()
      }
      return
    }
    if (m.t === 'open') {
      if (m.to && m.to !== this.deps.windowId) return
      this.knownGen = m.gen
      for (const sub of [...this.subs.values()]) {
        if (sub.gen === null) {
          sub.gen = m.gen
          this.post({ t: 'sub', w: this.deps.windowId, id: sub.id, sid: sub.sid, gen: m.gen })
        } else if (sub.gen !== m.gen) {
          this.fail(sub)
        }
      }
      for (const g of [...this.globals]) g.onOpen?.()
    } else if (m.t === 'ev') {
      for (const g of [...this.globals]) g.onEvent(m.type, m.data)
    } else if (m.t === 'nomux') {
      this.muxSupported = false
      for (const sub of [...this.subs.values()]) this.fail(sub)
      this.idle()
    }
  }

  private onOwn(m: WindowMessage): void {
    if (!m || typeof m !== 'object') return
    if (m.t === 's') {
      this.subs.get(m.id)?.callbacks.onEvent(m.type, m.data)
    } else if (m.t === 'e') {
      const sub = this.subs.get(m.id)
      if (!sub) return
      this.subs.delete(m.id)
      sub.callbacks.onDone?.()
      this.idle()
    }
  }
}

// ── runtime ────────────────────────────────────────────────────────────────

const windowId = (() => {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)
  return random.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
})()

const hubs = new Map<string, StreamHub>()

let enabled = false

/**
 * Share streams across windows. Off until the app entry opts in, so the API
 * layer needs no platform knowledge: mobile stays off (one window, and the OS
 * freezes background sockets).
 */
export function enableSharedStreams(): void {
  enabled = true
}

/**
 * This window's hub for the current backend, or null where streams are not
 * shared: not enabled, or no Web Locks / BroadcastChannel.
 */
export function runtimeHub(): StreamHub | null {
  if (!enabled) return null
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks || typeof BroadcastChannel === 'undefined') return null
  const key = apiBaseUrl()
  let hub = hubs.get(key)
  if (!hub) {
    hub = new StreamHub({
      locks,
      makeChannel: (name) => new BroadcastChannel(name) as unknown as ChannelLike,
      openStream: (clientId, callbacks, signal) => globalEventStream(callbacks, signal, clientId ?? undefined),
      putSubscriptions: putStreamSubscriptions,
      key,
      windowId,
      newId: () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${windowId}-${Date.now().toString(36)}`),
    })
    hubs.set(key, hub)
  }
  return hub
}

/** The app-lifetime feed, shared across windows where the platform can. */
export function sharedGlobalEventStream(callbacks: GlobalEventCallbacks, signal?: AbortSignal): void {
  const hub = runtimeHub()
  if (!hub) {
    globalEventStream(callbacks, signal)
    return
  }
  hub.subscribeGlobal(callbacks, signal)
}

/**
 * A session's stream over the shared feed. False when the caller must open
 * the session's own connection instead.
 */
export function sharedAgentStream(sessionId: string, callbacks: SSECallbacks, signal?: AbortSignal): boolean {
  const hub = runtimeHub()
  if (!hub || hub.muxSupported === false) return false
  hub.subscribeSession(sessionId, callbacks, signal)
  return true
}
