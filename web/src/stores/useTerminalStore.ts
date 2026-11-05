/**
 * useTerminalStore — app-wide terminal session registry.
 *
 * Terminals are owned HERE, not by React components. Each session's xterm
 * instance and WebSocket live in a module-level runtime map so they survive
 * component unmount — switching workspace-panel tabs or closing the panel
 * detaches the DOM but keeps the PTY alive. `TerminalView` is a thin
 * attach/detach renderer over these instances.
 *
 * Zustand state carries only serialisable metadata (status, titles, order)
 * so React re-renders on lifecycle changes without churning on every output
 * chunk (output goes straight to the persistent xterm instance).
 *
 * Sessions are keyed by a `contextKey` — the workspace path — so each
 * surface lists only its
 * own terminals while sharing one registry (and one backend session cap).
 *
 * Idle auto-close: detached sessions with no *user input* for
 * `TERMINAL_IDLE_CLOSE_MS` are closed by a store-level reaper (socket
 * closed → server SIGHUPs the PTY; renderer disposed). Attached (visible)
 * sessions are exempt — a terminal you're looking at never dies under you.
 * Output deliberately does NOT count as activity, otherwise a `tail -f`
 * would pin the PTY forever. The backend's own 30-minute reaper remains
 * the backstop for clients that vanish without closing.
 * Sessions running a command (`busy`, reported by the backend) are exempt
 * too, on both sides: a quiet dev server or build is never closed for idling.
 *
 * Protocol v2 (see api/terminal.ts): the shell outlives its socket.
 *  - Closing a tab (and idle-close) DELETEs the backend session, then closes
 *    the socket; a bare socket close only detaches.
 *  - An unexpected drop reattaches with backoff (`session_id` + `since=seq`);
 *    a 404 means the shell is gone (`closedReason: 'lost'`), a 4409 means a
 *    window took it over (`closedReason: 'elsewhere'`, Reconnect reattaches).
 *  - After a reload `restoreSessions` lists the workspace's shells and
 *    attaches the free ones from `since=0`. Every session's title persists in
 *    localStorage by backend session id, and each workspace's tab order and
 *    last-active shell persist beside it, so a reload brings the tabs back as
 *    they were (names, order, the one in front) — see `oad:terminal-layout`.
 *  - A server that never sends `busy` (Windows) is never idle-closed: a
 *    dev server there would otherwise die after 15 minutes.
 *  - The first connect waits for the view's first fit so the shell starts at
 *    the real width (with a short fallback for terminals nobody shows).
 */

import { create } from 'zustand'

import { connectTerminal, type TerminalSocket, type TerminalTarget } from '@/api/terminal'
import { deleteTerminalSession, listTerminalSessions } from '@/api/terminal-sessions'
import type { XtermHandle } from '@/components/Terminal/xterm-instance'
import { TERMINAL_THEMES, type TerminalResolvedTheme } from '@/components/Terminal/terminal-themes'
import { readStoredPreference, resolveTheme } from '@/lib/theme'
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from '@/lib/terminal-font'

export const TERMINAL_IDLE_CLOSE_MS = 15 * 60 * 1000
const REAPER_TICK_MS = 60 * 1000
/** Delays before each automatic reattach after an unexpected drop; then give up. */
export const TERMINAL_REATTACH_DELAYS_MS = [500, 1000, 2000, 4000, 8000]
/** How long a new terminal waits for its view's first fit before connecting anyway. */
export const TERMINAL_FIRST_FIT_WAIT_MS = 150
/** Written to xterm where older output was dropped on the server. */
export const TERMINAL_GAP_NOTICE = '\x1b[2m[earlier output skipped]\x1b[0m\r\n'
/** localStorage: `{ [backendSessionId]: { title, workspace } }` for renamed tabs. */
export const TERMINAL_TITLES_KEY = 'oad:terminal-titles'
/** localStorage: `{ [workspace]: { order: backendId[], active?: backendId } }`. */
export const TERMINAL_LAYOUT_KEY = 'oad:terminal-layout'
/** How long "Open terminal" waits for a restore that is still listing shells. */
export const TERMINAL_RESTORE_WAIT_MS = 2000

export type TerminalSessionStatus = 'connecting' | 'connected' | 'exited' | 'error'
/**
 * Why a session is `exited`: the shell exited, was closed for idling, is gone
 * from the server (`lost`), or another window took it over (`elsewhere` —
 * the shell still runs; Reconnect takes it back).
 */
export type TerminalClosedReason = 'exit' | 'idle' | 'lost' | 'elsewhere'

/** The tab-overlay text for a session that is not running. */
export function terminalClosedMessage(reason: TerminalClosedReason | undefined): string {
  switch (reason) {
    case 'idle':
      return 'Session ended — closed after 15 min idle'
    case 'lost':
      return 'Session ended — the shell is no longer running on the server'
    case 'elsewhere':
      return 'Opened in another window'
    default:
      return 'Session ended'
  }
}

export interface TerminalSessionMeta {
  id: string
  contextKey: string
  title: string
  status: TerminalSessionStatus
  closedReason?: TerminalClosedReason
  errorMsg?: string
  /** The server-side session id (protocol v2 only; set once attached). */
  backendId?: string
  /** Wire protocol the session connected with. */
  protocol?: 1 | 2
  /**
   * A command is running in the shell (not just the prompt). The backend
   * reports it on Unix; it stays unset on Windows. Busy sessions are never
   * idle-closed, and closing one from the tab asks first.
   */
  busy?: boolean
  /**
   * True once the xterm handle exists. ``@xterm/*`` is ~352 kB minified and
   * loads on demand, so a session is briefly live with no terminal object at
   * all. ``TerminalView`` keys its attach effect on this: without it the
   * effect would only re-run on the next ``status`` change, which happens to
   * follow handle creation today but is not guaranteed to.
   */
  handleReady?: boolean
  /** Monotonic open order for stable tab listing. */
  order: number
}

/** Non-reactive per-session runtime: xterm + socket + activity clock. */
export interface TerminalRuntime {
  target: TerminalTarget
  handle: XtermHandle | null
  socket: TerminalSocket | null
  lastActivityAt: number
  attached: boolean
  inputTransform: (data: string) => string
  /** Next byte expected from the server (v2): where a reattach resumes. */
  seq: number
  /** The server has sent at least one `busy` frame (Unix); never on Windows. */
  busySupported: boolean
  /** The view has fitted this terminal to its container at least once. */
  fitted: boolean
  /** Connection generation: events from older sockets are ignored. */
  gen: number
  /** Consecutive failed automatic reattaches. */
  reattachAttempts: number
  reattachTimer: ReturnType<typeof setTimeout> | null
  /** Releases a connect waiting for the first fit. */
  releaseFit: (() => void) | null
}

const runtimes = new Map<string, TerminalRuntime>()
let nextOrder = 0
let reaperTimer: ReturnType<typeof setInterval> | null = null
let currentTheme: TerminalResolvedTheme = resolveTheme(readStoredPreference())
/** Size of the last terminal a view fitted: a decent guess for hidden ones. */
let lastFittedSize: { rows: number; cols: number } | null = null
/** Workspaces whose surviving shells were already listed this page load. */
const restoredContexts = new Set<string>()
/** Restores in flight, so a request that needs the shells can wait for them. */
const pendingRestores = new Map<string, Promise<void>>()
/** Workspaces whose restore finished: only then may the tab order be saved. */
const settledContexts = new Set<string>()
/** The shell (backend id) that was in front before the reload, if it came back. */
const restoredActive = new Map<string, string>()

export function getTerminalRuntime(id: string): TerminalRuntime | undefined {
  return runtimes.get(id)
}

// ── Persisted titles ────────────────────────────────────────────────────────

type StoredTitles = Record<string, { title: string; workspace: string }>

function readTitles(): StoredTitles {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TERMINAL_TITLES_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredTitles) : {}
  } catch {
    return {}
  }
}

function writeTitles(titles: StoredTitles): void {
  try {
    localStorage.setItem(TERMINAL_TITLES_KEY, JSON.stringify(titles))
  } catch {
    // storage full or unavailable: titles are a nicety
  }
}

function persistTitle(backendId: string, workspace: string, title: string): void {
  writeTitles({ ...readTitles(), [backendId]: { title, workspace } })
}

function forgetTitle(backendId: string): void {
  const titles = readTitles()
  if (!(backendId in titles)) return
  delete titles[backendId]
  writeTitles(titles)
}

/** Drop this workspace's titles for sessions the server no longer has. */
function pruneTitles(workspace: string, alive: ReadonlySet<string>): void {
  const titles = readTitles()
  let changed = false
  for (const [backendId, entry] of Object.entries(titles)) {
    if (entry?.workspace === workspace && !alive.has(backendId)) {
      delete titles[backendId]
      changed = true
    }
  }
  if (changed) writeTitles(titles)
}

// ── Persisted tab order and active shell ────────────────────────────────────

interface StoredLayout {
  order: string[]
  active?: string
}

function readLayouts(): Record<string, StoredLayout> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TERMINAL_LAYOUT_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const layouts: Record<string, StoredLayout> = {}
    for (const [workspace, raw] of Object.entries(parsed as Record<string, Partial<StoredLayout> | null>)) {
      if (!raw || typeof raw !== 'object') continue
      const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === 'string') : []
      layouts[workspace] = { order, ...(typeof raw.active === 'string' ? { active: raw.active } : {}) }
    }
    return layouts
  } catch {
    return {}
  }
}

/** Merge changes into a workspace's saved layout (written only when it differs). */
function patchLayout(workspace: string, changes: Partial<StoredLayout>, createIfMissing = true): void {
  const layouts = readLayouts()
  const current = layouts[workspace]
  if (!current && !createIfMissing) return
  const next: StoredLayout = {
    order: changes.order ?? current?.order ?? [],
    active: 'active' in changes ? changes.active : current?.active,
  }
  if (next.active === undefined) delete next.active
  if (JSON.stringify(next) === JSON.stringify(current)) return
  try {
    localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify({ ...layouts, [workspace]: next }))
  } catch {
    // storage full or unavailable: the layout is a nicety
  }
}

/** The shell the user is looking at now is the one to bring to the front after a reload. */
function rememberActive(id: string): void {
  const meta = useTerminalStore.getState().sessions[id]
  if (runtimes.get(id)?.attached && meta?.protocol === 2 && meta.backendId) {
    patchLayout(meta.contextKey, { active: meta.backendId })
  }
}

interface TerminalStore {
  sessions: Record<string, TerminalSessionMeta>
  /** Create a session and start connecting. Returns the new session id. */
  open: (target: TerminalTarget, contextKey: string) => string
  /**
   * Bring a dead (exited/error/idle-closed/other-window) session back in
   * place: reattach its shell when the server still has it, else start a new one.
   */
  reconnect: (id: string) => void
  /** Tear down socket + renderer, kill the shell (v2), and forget the session. */
  close: (id: string) => void
  /**
   * Once per workspace and page load: list the shells the server kept and
   * attach the ones nobody holds (replaying their output). Never throws.
   */
  restoreSessions: (contextKey: string) => Promise<void>
  /**
   * A promise for the restore in flight for this workspace, bounded by
   * `timeoutMs`; null when none is running (nothing to wait for).
   */
  waitForRestore: (contextKey: string, timeoutMs?: number) => Promise<void> | null
  /** The shell that was in front before the reload, once restored (a backend id). */
  restoredActiveBackendId: (contextKey: string) => string | undefined
  /**
   * The dock's tab order for this workspace (store session ids), to persist.
   * Ignored until the workspace's restore has settled, so a fresh page can
   * never overwrite the order it is about to restore.
   */
  noteTerminalOrder: (contextKey: string, sessionIds: readonly string[]) => void
  sendInput: (id: string, data: string) => void
  sendResize: (id: string, rows: number, cols: number) => void
  /** Visible ↔ hidden — attached sessions are exempt from idle reaping. */
  setAttached: (id: string, attached: boolean) => void
  noteActivity: (id: string) => void
  /** Sticky-Ctrl and friends — owned by whichever view drives the keys. */
  setInputTransform: (id: string, transform: (data: string) => string) => void
  /** User-driven rename (desktop right-click / mobile long-press). Blank is a no-op. */
  rename: (id: string, title: string) => void
  /** Clear the scrollback, keeping the prompt line (the tab menu's Clear). */
  clear: (id: string) => void
  /** Swap every live terminal's palette when the app theme resolves anew. */
  syncTheme: (theme: TerminalResolvedTheme) => void
  /** Close detached sessions idle past TERMINAL_IDLE_CLOSE_MS. */
  reapIdle: (now?: number) => void
  sessionsForContext: (contextKey: string) => TerminalSessionMeta[]
}

function nextTitle(sessions: Record<string, TerminalSessionMeta>, contextKey: string): string {
  let maxN = 0
  for (const meta of Object.values(sessions)) {
    if (meta.contextKey !== contextKey) continue
    const m = /^Terminal (\d+)$/.exec(meta.title)
    if (m) maxN = Math.max(maxN, Number(m[1]))
  }
  return `Terminal ${maxN + 1}`
}

function ensureReaper(store: TerminalStore): void {
  if (reaperTimer !== null) return
  reaperTimer = setInterval(() => store.reapIdle(), REAPER_TICK_MS)
}

function stopReaperIfEmpty(sessions: Record<string, TerminalSessionMeta>): void {
  if (Object.keys(sessions).length === 0 && reaperTimer !== null) {
    clearInterval(reaperTimer)
    reaperTimer = null
  }
}

/** Dispose runtime resources; never throws (renderer may be mid-teardown). */
function teardownRuntime(rt: TerminalRuntime): void {
  rt.gen++ // late events of the socket below must not count
  if (rt.reattachTimer !== null) clearTimeout(rt.reattachTimer)
  rt.reattachTimer = null
  rt.releaseFit?.()
  try {
    rt.socket?.close()
  } catch {
    // already closed
  }
  rt.socket = null
  try {
    rt.handle?.term.dispose()
  } catch {
    // already disposed
  }
  rt.handle = null
  rt.fitted = false
}

function patchSession(id: string, changes: Partial<TerminalSessionMeta>): void {
  useTerminalStore.setState((state) => {
    const meta = state.sessions[id]
    if (!meta) return {}
    return { sessions: { ...state.sessions, [id]: { ...meta, ...changes } } }
  })
}

/** Forget a session's runtime and metadata (no server traffic). */
function dropSession(id: string): void {
  const rt = runtimes.get(id)
  if (rt) teardownRuntime(rt)
  runtimes.delete(id)
  useTerminalStore.setState((state) => {
    const sessions = { ...state.sessions }
    delete sessions[id]
    stopReaperIfEmpty(sessions)
    return { sessions }
  })
}

/** Kill a v2 shell on the server. Failure is harmless: its own reaper is the backstop. */
function killBackendSession(backendId: string): void {
  deleteTerminalSession(backendId).catch(() => {})
}

/** Does closing this session's tab have to kill a shell on the server? */
function holdsLiveShell(meta: TerminalSessionMeta | undefined): meta is TerminalSessionMeta & { backendId: string } {
  // `exited` covers a shell that ended and one another window now owns.
  return meta?.protocol === 2 && !!meta.backendId && meta.status !== 'exited'
}

/** The kind of a connect failure (see TerminalConnectError), duck-typed. */
function failureKind(err: unknown): string | undefined {
  const kind = (err as { kind?: unknown } | null)?.kind
  return typeof kind === 'string' ? kind : undefined
}

/** Resolves once the view fitted the terminal, or after a short fallback. */
function waitForFirstFit(rt: TerminalRuntime): Promise<void> {
  if (rt.fitted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      rt.releaseFit = null
      resolve()
    }
    const timer = setTimeout(done, TERMINAL_FIRST_FIT_WAIT_MS)
    rt.releaseFit = done
  })
}

/** Where a connect attempt came from, which decides how its failure reads. */
type ResumeOrigin = 'auto' | 'manual' | 'restore'
interface Resume {
  sessionId: string
  since: number
  origin: ResumeOrigin
}

/** Forget the old shell so the next connect spawns a new one. */
function resetForFreshShell(id: string, rt: TerminalRuntime): void {
  rt.seq = 0
  rt.busySupported = false
  patchSession(id, { backendId: undefined, protocol: undefined, busy: false })
}

function scheduleReattach(id: string, rt: TerminalRuntime): void {
  const backendId = useTerminalStore.getState().sessions[id]?.backendId
  const delay = TERMINAL_REATTACH_DELAYS_MS[rt.reattachAttempts]
  if (!backendId || delay === undefined) {
    // Out of tries: the user can Reconnect (which tries this shell first).
    rt.reattachAttempts = 0
    patchSession(id, { status: 'error', errorMsg: 'Connection lost', busy: false })
    return
  }
  rt.reattachAttempts++
  patchSession(id, { status: 'connecting', errorMsg: undefined })
  rt.reattachTimer = setTimeout(() => {
    rt.reattachTimer = null
    if (runtimes.get(id) !== rt) return
    void connect(id, { sessionId: backendId, since: rt.seq, origin: 'auto' })
  }, delay)
}

async function connect(id: string, resume?: Resume): Promise<void> {
  const rt = runtimes.get(id)
  if (!rt) return
  const gen = ++rt.gen
  const live = () => runtimes.get(id) === rt && rt.gen === gen
  const patch = (changes: Partial<TerminalSessionMeta>) => patchSession(id, changes)

  if (rt.handle === null) {
    // Loaded on demand: xterm plus its WebGL and unicode addons are ~352 kB
    // minified, and a session that never opens a terminal should never pay to
    // parse them. The import resolves from the module registry on every later
    // terminal, so only the first one waits.
    const { createXterm } = await import('@/components/Terminal/xterm-instance')
    if (!live()) return // closed while the chunk was loading
    rt.handle = createXterm({ theme: currentTheme, fontSize: TERMINAL_FONT_SIZE, fontFamily: TERMINAL_FONT_FAMILY })
    // Wire keystrokes once, for the lifetime of this xterm instance — this is
    // the only place a handle is born, so it cannot double-register.
    rt.handle.term.onData((data) => useTerminalStore.getState().sendInput(id, data))
    patch({ handleReady: true })
  }
  const { term } = rt.handle

  // Sizing: a fresh terminal has not been fitted to a container yet — that
  // happens when its view mounts (`setAttached`). Connect then, so the shell
  // draws its first prompt at the real width. A terminal nobody shows (a
  // restored background tab) borrows the last fitted size after a short wait;
  // the view's own resize corrects it once it appears. A reconnect of an
  // already-fitted handle skips the wait.
  if (!rt.fitted) await waitForFirstFit(rt)
  if (!live()) return
  const size = rt.fitted || !lastFittedSize ? { rows: term.rows, cols: term.cols } : lastFittedSize

  connectTerminal(
    rt.target,
    {
      onOutput: (data) => {
        if (live()) term.write(data)
      },
      onData: (bytes, done) => {
        if (live()) term.write(bytes, done)
      },
      onGap: () => {
        if (live()) term.write(TERMINAL_GAP_NOTICE)
      },
      onSeq: (seq) => {
        if (live()) rt.seq = seq
      },
      onExit: () => {
        if (live()) patch({ status: 'exited', closedReason: 'exit', busy: false })
      },
      onBusy: (busy) => {
        if (!live()) return
        rt.busySupported = true
        // A command that just finished gets a full idle window, so its
        // output is still there when the user comes back to it.
        if (!busy) rt.lastActivityAt = Date.now()
        if (useTerminalStore.getState().sessions[id]?.busy !== busy) patch({ busy })
      },
      onError: () => {
        if (!live()) return
        // v2: a socket error is always followed by a close, which decides.
        if (useTerminalStore.getState().sessions[id]?.protocol === 2) return
        if (useTerminalStore.getState().sessions[id]?.status === 'connected') {
          patch({ status: 'error', errorMsg: 'Terminal connection error', busy: false })
        }
      },
      onClose: (code) => {
        if (!live()) return
        const current = useTerminalStore.getState().sessions[id]
        if (current?.status !== 'connected') return
        if (current.protocol !== 2) {
          patch({ status: 'exited', closedReason: 'exit', busy: false })
          return
        }
        rt.gen++ // anything else this socket says is stale
        rt.socket = null
        if (code === 4409) {
          patch({ status: 'exited', closedReason: 'elsewhere', busy: false })
        } else if (code === 4429) {
          patch({ status: 'error', errorMsg: 'Could not start the shell', busy: false })
        } else {
          // Network or backend hiccup: the shell lives on, so reattach.
          scheduleReattach(id, rt)
        }
      },
    },
    size,
    resume ? { sessionId: resume.sessionId, since: resume.since } : undefined,
  )
    .then((socket) => {
      if (!live()) {
        // Closed (or superseded) while the handshake was in flight. A v2
        // shell outlives its socket, so a closed tab must kill it explicitly.
        if (runtimes.get(id) !== rt && socket.protocol === 2 && socket.sessionId) {
          killBackendSession(socket.sessionId)
        }
        socket.close()
        return
      }
      const v2 = socket.protocol === 2
      rt.socket = socket
      rt.reattachAttempts = 0
      rt.lastActivityAt = Date.now()
      const backendId = v2 ? socket.sessionId : undefined
      patch({
        status: 'connected',
        closedReason: undefined,
        errorMsg: undefined,
        protocol: v2 ? 2 : 1,
        backendId,
      })
      if (backendId) {
        // Every title, not only renames: a reload must not renumber the tabs.
        persistTitle(backendId, rt.target.workspace, useTerminalStore.getState().sessions[id]?.title ?? '')
        rememberActive(id)
      }
    })
    .catch((err: Error) => {
      if (!live()) return
      const kind = failureKind(err)
      if (!resume) {
        patch({ status: 'error', errorMsg: err.message })
        return
      }
      if (kind === 'gone') {
        if (resume.origin === 'restore') dropSession(id) // nothing to show for it
        else if (resume.origin === 'manual') {
          // Reconnect found the shell gone: start a new one in this tab.
          resetForFreshShell(id, rt)
          void connect(id)
        } else patch({ status: 'exited', closedReason: 'lost', busy: false })
      } else if (kind === 'elsewhere') {
        if (resume.origin === 'restore') dropSession(id) // another window owns it
        else patch({ status: 'exited', closedReason: 'elsewhere', busy: false })
      } else if (kind === 'spawn-failed' || resume.origin === 'manual') {
        patch({ status: 'error', errorMsg: err.message })
      } else {
        scheduleReattach(id, rt)
      }
    })
}

function newRuntime(target: TerminalTarget): TerminalRuntime {
  return {
    target,
    handle: null,
    socket: null,
    lastActivityAt: Date.now(),
    attached: false,
    inputTransform: (d) => d,
    seq: 0,
    busySupported: false,
    fitted: false,
    gen: 0,
    reattachAttempts: 0,
    reattachTimer: null,
    releaseFit: null,
  }
}

function createSession(
  target: TerminalTarget,
  contextKey: string,
  init: { title?: string; busy?: boolean; resume?: Resume } = {},
): string {
  const id = `term-${++nextOrder}-${Date.now().toString(36)}`
  const rt = newRuntime(target)
  runtimes.set(id, rt)
  useTerminalStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [id]: {
        id,
        contextKey,
        title: init.title ?? nextTitle(state.sessions, contextKey),
        status: 'connecting',
        order: nextOrder,
        ...(init.resume ? { backendId: init.resume.sessionId, protocol: 2 as const } : {}),
        ...(init.busy ? { busy: true } : {}),
      },
    },
  }))
  ensureReaper(useTerminalStore.getState())
  void connect(id, init.resume)
  return id
}

/**
 * List the workspace's surviving shells and bring back the free ones: in the
 * saved tab order (the rest after, oldest first), with their saved titles.
 */
async function runRestore(contextKey: string): Promise<void> {
  restoredContexts.add(contextKey)
  let list: Awaited<ReturnType<typeof listTerminalSessions>>
  try {
    list = await listTerminalSessions(contextKey)
  } catch {
    restoredContexts.delete(contextKey) // try again the next time they are needed
    return
  }
  const store = useTerminalStore.getState()
  const known = new Set(
    Object.values(store.sessions)
      .map((m) => m.backendId)
      .filter((b): b is string => !!b),
  )
  const alive = new Set([...list.map((s) => s.session_id), ...known])
  pruneTitles(contextKey, alive)

  const saved = readLayouts()[contextKey]
  const order = (saved?.order ?? []).filter((b) => alive.has(b))
  const active = saved?.active && alive.has(saved.active) ? saved.active : undefined
  if (saved) patchLayout(contextKey, { order, active }, false)

  // A shell another window holds is theirs; one we already show is ours.
  const free = list.filter((info) => !info.attached && !known.has(info.session_id))
  const rank = (sessionId: string) => {
    const at = order.indexOf(sessionId)
    return at < 0 ? Number.POSITIVE_INFINITY : at
  }
  // Stable sort: shells without a saved place keep the server's oldest-first order.
  free.sort((a, b) => {
    const [ra, rb] = [rank(a.session_id), rank(b.session_id)]
    return ra === rb ? 0 : ra < rb ? -1 : 1
  })
  if (active && free.some((info) => info.session_id === active)) restoredActive.set(contextKey, active)
  else restoredActive.delete(contextKey)

  const titles = readTitles()
  for (const info of free) {
    createSession({ workspace: info.workspace || contextKey }, contextKey, {
      title: titles[info.session_id]?.title,
      busy: info.busy,
      resume: { sessionId: info.session_id, since: 0, origin: 'restore' },
    })
  }
  settledContexts.add(contextKey)
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  sessions: {},

  open: (target, contextKey) => createSession(target, contextKey),

  reconnect: (id) => {
    const rt = runtimes.get(id)
    const meta = get().sessions[id]
    if (!rt || !meta || meta.status === 'connected' || meta.status === 'connecting') return
    // The same shell, if the server may still have it: another window took
    // it over, or we gave up reconnecting. An ended shell starts anew.
    const sameShell =
      meta.protocol === 2 && !!meta.backendId && (meta.closedReason === 'elsewhere' || meta.status === 'error')
    rt.gen++
    if (rt.reattachTimer !== null) clearTimeout(rt.reattachTimer)
    rt.reattachTimer = null
    try {
      rt.socket?.close()
    } catch {
      // already closed
    }
    rt.socket = null
    rt.lastActivityAt = Date.now()
    if (!sameShell && meta.backendId) resetForFreshShell(id, rt)
    patchSession(id, { status: 'connecting', closedReason: undefined, errorMsg: undefined })
    void connect(id, sameShell ? { sessionId: meta.backendId!, since: rt.seq, origin: 'manual' } : undefined)
  },

  close: (id) => {
    const rt = runtimes.get(id)
    const meta = get().sessions[id]
    // Kill first, then drop the socket: with v2 the socket close alone only detaches.
    if (holdsLiveShell(meta)) killBackendSession(meta.backendId)
    if (meta?.backendId) {
      forgetTitle(meta.backendId)
      const saved = readLayouts()[meta.contextKey]
      if (saved) {
        patchLayout(meta.contextKey, {
          order: saved.order.filter((b) => b !== meta.backendId),
          active: saved.active === meta.backendId ? undefined : saved.active,
        })
      }
    }
    if (rt) teardownRuntime(rt)
    dropSession(id)
  },

  restoreSessions: (contextKey) => {
    const running = pendingRestores.get(contextKey)
    if (running) return running
    if (restoredContexts.has(contextKey)) return Promise.resolve()
    const restoring = runRestore(contextKey).finally(() => pendingRestores.delete(contextKey))
    pendingRestores.set(contextKey, restoring)
    return restoring
  },

  waitForRestore: (contextKey, timeoutMs = TERMINAL_RESTORE_WAIT_MS) => {
    const running = pendingRestores.get(contextKey)
    if (!running) return null
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      running.then(done, done)
    })
  },

  restoredActiveBackendId: (contextKey) => restoredActive.get(contextKey),

  noteTerminalOrder: (contextKey, sessionIds) => {
    if (!settledContexts.has(contextKey)) return
    const sessions = get().sessions
    const order: string[] = []
    const add = (meta: TerminalSessionMeta | undefined) => {
      if (meta?.contextKey === contextKey && meta.backendId && !order.includes(meta.backendId)) {
        order.push(meta.backendId)
      }
    }
    for (const id of sessionIds) add(sessions[id])
    // Shells the dock has no tab for yet keep their place, after the others.
    for (const meta of get().sessionsForContext(contextKey)) add(meta)
    patchLayout(contextKey, { order })
  },

  sendInput: (id, data) => {
    const rt = runtimes.get(id)
    if (!rt?.socket) return
    rt.lastActivityAt = Date.now()
    rt.socket.sendInput(rt.inputTransform(data))
  },

  sendResize: (id, rows, cols) => {
    runtimes.get(id)?.socket?.sendResize(rows, cols)
  },

  setAttached: (id, attached) => {
    const rt = runtimes.get(id)
    if (!rt) return
    rt.attached = attached
    if (attached && rt.handle) {
      // The view just opened the terminal in its container: measure it now so
      // a connect that was waiting for the first fit uses the real size.
      try {
        rt.handle.fit.fit()
      } catch {
        // container not laid out yet — the view's own refit follows
      }
      rt.fitted = true
      lastFittedSize = { rows: rt.handle.term.rows, cols: rt.handle.term.cols }
      rt.releaseFit?.()
    }
    if (attached) rememberActive(id)
    // Restart the idle clock on detach so a just-hidden terminal gets the
    // full window before the reaper considers it.
    if (!attached) rt.lastActivityAt = Date.now()
  },

  noteActivity: (id) => {
    const rt = runtimes.get(id)
    if (rt) rt.lastActivityAt = Date.now()
  },

  setInputTransform: (id, transform) => {
    const rt = runtimes.get(id)
    if (rt) rt.inputTransform = transform
  },

  rename: (id, title) => {
    const trimmed = title.trim()
    if (!trimmed) return
    const meta = get().sessions[id]
    if (!meta) return
    set((state) => ({ sessions: { ...state.sessions, [id]: { ...state.sessions[id], title: trimmed } } }))
    const rt = runtimes.get(id)
    if (meta.backendId) persistTitle(meta.backendId, rt?.target.workspace ?? meta.contextKey, trimmed)
  },

  clear: (id) => {
    runtimes.get(id)?.handle?.term.clear()
  },

  syncTheme: (theme) => {
    currentTheme = theme
    for (const rt of runtimes.values()) {
      if (rt.handle) rt.handle.term.options.theme = TERMINAL_THEMES[theme]
    }
  },

  reapIdle: (now = Date.now()) => {
    for (const [id, rt] of runtimes) {
      const meta = get().sessions[id]
      if (!meta || meta.status !== 'connected') continue
      if (rt.attached || meta.busy) continue
      // A server that never reports `busy` (Windows) cannot tell us a dev
      // server is running, and closing kills the shell: never idle-close it.
      if (meta.protocol === 2 && !rt.busySupported) continue
      if (now - rt.lastActivityAt <= TERMINAL_IDLE_CLOSE_MS) continue
      if (holdsLiveShell(meta)) killBackendSession(meta.backendId)
      teardownRuntime(rt)
      patchSession(id, { status: 'exited', closedReason: 'idle' })
    }
  },

  sessionsForContext: (contextKey) =>
    Object.values(get().sessions)
      .filter((meta) => meta.contextKey === contextKey)
      .sort((a, b) => a.order - b.order),
}))

/** Test hook: wipe all sessions, runtimes, and the reaper interval. */
export function _resetTerminalStoreForTests(): void {
  for (const rt of runtimes.values()) teardownRuntime(rt)
  runtimes.clear()
  restoredContexts.clear()
  pendingRestores.clear()
  settledContexts.clear()
  restoredActive.clear()
  lastFittedSize = null
  nextOrder = 0
  if (reaperTimer !== null) {
    clearInterval(reaperTimer)
    reaperTimer = null
  }
  useTerminalStore.setState({ sessions: {} })
}
