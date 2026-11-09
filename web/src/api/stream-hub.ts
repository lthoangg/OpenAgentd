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

/**
 * One term of leadership: the feed this window opened and the subscription
 * set synchronized on it. A new term starts with fresh state, so nothing a
 * previous term left in flight (a subscription request, a frame, a close) can
 * apply to it: every callback names its term and is ignored once that term
 * is no longer the current one.
 */
interface Term {
  /** The client id the feed was opened with; subscriptions are bound to it. */
  readonly gen: string
  readonly mux: AbortController
  /** `open` once the server answered the feed; subscriptions go out only then. */
  feed: 'opening' | 'open'
  /** The server has accepted a subscription request on this feed. */
  proven: boolean
  /** Other windows' subscriptions, sent to this term's `gen`. */
  readonly remote: Map<string, { w: string; sid: string }>
  /** One request at a time; `dirty` asks the running loop for another pass. */
  readonly sync: { running: boolean; dirty: boolean; sent: string }
}

/**
 * Leader holds the Web Lock and a term; a follower only knows the leader's
 * `gen` once the leader has said its feed is open.
 */
type Role =
  | { kind: 'follower'; knownGen: string | null }
  | { kind: 'leader'; term: Term }

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
  private role: Role = { kind: 'follower', knownGen: null }
  /** Leader → window channels; closed when the term ends. */
  private readonly targets = new Map<string, ChannelLike>()

  constructor(deps: HubDeps) {
    this.deps = deps
    this.name = `${NAME_PREFIX}${deps.key}`
  }

  /** The current term, or null when this window does not lead. */
  private currentTerm(): Term | null {
    return this.role.kind === 'leader' ? this.role.term : null
  }

  // ── consumers ────────────────────────────────────────────────────────────

  subscribeGlobal(callbacks: GlobalEventCallbacks, signal?: AbortSignal): void {
    if (signal?.aborted) return
    this.globals.add(callbacks)
    this.engage()
    const term = this.currentTerm()
    if (term) {
      // Already open: tell this consumer without reopening anything.
      if (term.feed === 'open') {
        queueMicrotask(() => {
          if (this.currentTerm() === term && this.globals.has(callbacks)) callbacks.onOpen?.()
        })
      }
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
    const role = this.role
    if (role.kind === 'leader') {
      const { term } = role
      if (term.feed === 'open') {
        sub.gen = term.gen
        this.scheduleSync(term)
      }
    } else if (role.knownGen !== null) {
      sub.gen = role.knownGen
      this.post({ t: 'sub', w: this.deps.windowId, id, sid: sessionId, gen: role.knownGen })
    } else {
      this.post({ t: 'hello', w: this.deps.windowId })
    }
    signal?.addEventListener('abort', () => this.drop(id), { once: true })
  }

  private drop(id: string): void {
    const sub = this.subs.get(id)
    if (!sub) return
    this.subs.delete(id)
    const term = this.currentTerm()
    if (term) this.scheduleSync(term)
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
    const term = this.currentTerm()
    if (term) {
      term.mux.abort()
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
    this.role = { kind: 'follower', knownGen: null }
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
    const term: Term = {
      gen: this.deps.newId(),
      mux: new AbortController(),
      feed: 'opening',
      proven: false,
      remote: new Map(),
      sync: { running: false, dirty: false, sent: '' },
    }
    this.role = { kind: 'leader', term }
    // What was sent to the previous leader is not carried over.
    for (const sub of [...this.subs.values()]) if (sub.gen !== null) this.fail(sub)
    this.openMux(term)
  }

  /** Ends the current term; anything it left in flight no longer applies. */
  private stepDown(): void {
    this.role = { kind: 'follower', knownGen: null }
    for (const channel of this.targets.values()) channel.close()
    this.targets.clear()
    const release = this.release
    this.release = null
    this.election = null
    release?.()
  }

  private openMux(term: Term): void {
    const { gen } = term
    this.deps.openStream(
      this.muxSupported === false ? null : gen,
      {
        onOpen: () => {
          if (this.currentTerm() !== term) return
          term.feed = 'open'
          this.post({ t: 'open', gen })
          for (const sub of this.subs.values()) if (sub.gen === null) sub.gen = gen
          for (const g of [...this.globals]) g.onOpen?.()
          this.scheduleSync(term)
        },
        onEvent: (type, data) => {
          if (this.currentTerm() === term) this.onFrame(term, type, data)
        },
        onParseError: (error) => {
          if (this.currentTerm() === term) for (const g of this.globals) g.onParseError?.(error)
        },
        onError: (error) => this.muxDown(term, error),
        onDone: () => this.muxDown(term, null),
      },
      term.mux.signal,
    )
  }

  /**
   * The feed ended: every subscription on it is lost, and so is leadership.
   * The term ends before anyone is told, so a consumer that subscribes again
   * from its callback waits for the next term instead of binding to this one.
   */
  private muxDown(term: Term, error: Error | null): void {
    if (this.currentTerm() !== term) return
    term.mux.abort()
    const lost = [...this.subs.values()]
    this.stepDown()
    for (const sub of lost) this.fail(sub)
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

  private onFrame(term: Term, type: string, data: unknown): void {
    if (type === 'session_event') {
      const frame = data as { sub_id?: unknown; type?: unknown; data?: unknown }
      if (typeof frame.sub_id === 'string' && typeof frame.type === 'string') this.route(term, frame.sub_id, frame.type, frame.data)
      return
    }
    if (type === 'session_stream_end') {
      const id = (data as { sub_id?: unknown }).sub_id
      if (typeof id === 'string') this.endSub(term, id)
      return
    }
    for (const g of [...this.globals]) g.onEvent(type, data)
    this.post({ t: 'ev', type, data })
  }

  private route(term: Term, id: string, type: string, data: unknown): void {
    const local = this.subs.get(id)
    if (local) {
      local.callbacks.onEvent(type, data)
      return
    }
    const remote = term.remote.get(id)
    if (remote) this.tell(remote.w, { t: 's', id, type, data })
  }

  private endSub(term: Term, id: string): void {
    const local = this.subs.get(id)
    if (local) {
      this.subs.delete(id)
      local.callbacks.onDone?.()
    } else {
      const remote = term.remote.get(id)
      if (!remote) return
      term.remote.delete(id)
      this.tell(remote.w, { t: 'e', id })
    }
    this.scheduleSync(term)
  }

  // ── leader: subscriptions out ────────────────────────────────────────────

  private wanted(term: Term): StreamSubscription[] {
    const out: StreamSubscription[] = []
    for (const sub of this.subs.values()) if (sub.gen === term.gen) out.push({ id: sub.id, session_id: sub.sid })
    for (const [id, r] of term.remote) out.push({ id, session_id: r.sid })
    return out
  }

  /**
   * Sends the full set, one request at a time and only when it changed. The
   * loop belongs to its term: a request still out when the term ends neither
   * delays the next term's requests nor applies its answer to them.
   */
  private scheduleSync(term: Term): void {
    if (this.currentTerm() !== term || term.mux.signal.aborted) return
    if (term.feed !== 'open' || this.muxSupported === false) return
    const { sync } = term
    sync.dirty = true
    if (sync.running) return
    sync.running = true
    void (async () => {
      try {
        while (sync.dirty && this.currentTerm() === term) {
          sync.dirty = false
          const wanted = this.wanted(term)
          const signature = wanted.map((s) => s.id).sort().join(',')
          if (signature === sync.sent) continue
          const timeout = new AbortController()
          const timer = setTimeout(() => timeout.abort(), this.deps.putTimeoutMs ?? PUT_TIMEOUT_MS)
          let result: 'ok' | 'gone' | 'error'
          try {
            result = await this.deps.putSubscriptions(term.gen, wanted, timeout.signal)
          } finally {
            clearTimeout(timer)
          }
          if (this.currentTerm() !== term) return
          if (timeout.signal.aborted && result !== 'ok') {
            console.warn(`[stream-hub] subscription request timed out; restarting the shared feed (${wanted.length} sessions)`)
          }
          if (result === 'ok') {
            term.proven = true
            sync.sent = signature
          } else if (result === 'gone' && !term.proven && this.muxSupported === null) {
            // The server answered 404 to a feed it just opened: an older
            // server that serves the global feed but not sessions on it.
            this.unsupported(term)
            return
          } else {
            this.muxDown(term, new Error('Connection closed: could not subscribe to sessions'))
            return
          }
        }
      } finally {
        sync.running = false
      }
    })()
  }

  private unsupported(term: Term): void {
    this.muxSupported = false
    this.post({ t: 'nomux' })
    for (const sub of [...this.subs.values()]) this.fail(sub)
    term.remote.clear()
    this.idle()
  }

  // ── messages ─────────────────────────────────────────────────────────────

  private onShared(m: SharedMessage): void {
    if (!m || typeof m !== 'object') return
    const term = this.currentTerm()
    if (term) {
      if (m.t === 'hello') {
        if (this.muxSupported === false) this.post({ t: 'nomux' })
        if (term.feed === 'open') this.post({ t: 'open', gen: term.gen, to: m.w })
      } else if (m.t === 'sub') {
        if (term.feed === 'open' && m.gen === term.gen && this.muxSupported !== false) {
          term.remote.set(m.id, { w: m.w, sid: m.sid })
          this.scheduleSync(term)
        }
      } else if (m.t === 'unsub') {
        if (term.remote.delete(m.id)) this.scheduleSync(term)
      } else if (m.t === 'bye') {
        let changed = false
        for (const [id, r] of term.remote) {
          if (r.w !== m.w) continue
          term.remote.delete(id)
          changed = true
        }
        this.targets.get(m.w)?.close()
        this.targets.delete(m.w)
        if (changed) this.scheduleSync(term)
      }
      return
    }
    if (m.t === 'open') {
      if (m.to && m.to !== this.deps.windowId) return
      this.role = { kind: 'follower', knownGen: m.gen }
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
