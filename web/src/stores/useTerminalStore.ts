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
 * Sessions are keyed by a `contextKey` — the coding workspace path or
 * `session:{chatSessionId}` for cockpit — so each surface lists only its
 * own terminals while sharing one registry (and one backend session cap).
 *
 * Idle auto-close: detached sessions with no *user input* for
 * `TERMINAL_IDLE_CLOSE_MS` are closed by a store-level reaper (socket
 * closed → server SIGHUPs the PTY; renderer disposed). Attached (visible)
 * sessions are exempt — a terminal you're looking at never dies under you.
 * Output deliberately does NOT count as activity, otherwise a `tail -f`
 * would pin the PTY forever. The backend's own 30-minute reaper remains
 * the backstop for clients that vanish without closing.
 */

import { create } from 'zustand'

import { connectTerminal, type TerminalSocket, type TerminalTarget } from '@/api/terminal'
import { createXterm, type XtermHandle } from '@/components/Terminal/xterm-instance'
import { TERMINAL_THEMES, type TerminalResolvedTheme } from '@/components/Terminal/terminal-themes'
import { readStoredPreference, resolveTheme } from '@/lib/theme'
import { buildTerminalFontFamily, readStoredTerminalFont } from '@/lib/terminal-font'

export const TERMINAL_IDLE_CLOSE_MS = 15 * 60 * 1000
const REAPER_TICK_MS = 60 * 1000

export type TerminalSessionStatus = 'connecting' | 'connected' | 'exited' | 'error'
export type TerminalClosedReason = 'exit' | 'idle'

export interface TerminalSessionMeta {
  id: string
  contextKey: string
  title: string
  status: TerminalSessionStatus
  closedReason?: TerminalClosedReason
  errorMsg?: string
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
}

const runtimes = new Map<string, TerminalRuntime>()
let nextOrder = 0
let reaperTimer: ReturnType<typeof setInterval> | null = null
let currentTheme: TerminalResolvedTheme = resolveTheme(readStoredPreference())
let currentFontFamily: string = buildTerminalFontFamily(readStoredTerminalFont())

export function getTerminalRuntime(id: string): TerminalRuntime | undefined {
  return runtimes.get(id)
}

interface TerminalStore {
  sessions: Record<string, TerminalSessionMeta>
  /** Create a session and start connecting. Returns the new session id. */
  open: (target: TerminalTarget, contextKey: string) => string
  /** Re-launch a dead (exited/error/idle-closed) session in place. */
  reconnect: (id: string) => void
  /** Tear down socket + renderer and forget the session entirely. */
  close: (id: string) => void
  sendInput: (id: string, data: string) => void
  sendResize: (id: string, rows: number, cols: number) => void
  /** Visible ↔ hidden — attached sessions are exempt from idle reaping. */
  setAttached: (id: string, attached: boolean) => void
  noteActivity: (id: string) => void
  /** Sticky-Ctrl and friends — owned by whichever view drives the keys. */
  setInputTransform: (id: string, transform: (data: string) => string) => void
  /** User-driven rename (desktop right-click / mobile long-press). Blank is a no-op. */
  rename: (id: string, title: string) => void
  /** Swap every live terminal's palette when the app theme resolves anew. */
  syncTheme: (theme: TerminalResolvedTheme) => void
  /** Swap every live terminal's font stack (Settings → Terminal font change). */
  syncFont: (customFont: string | null) => void
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
}

function connect(
  id: string,
  set: (fn: (state: TerminalStore) => Partial<TerminalStore>) => void,
): void {
  const rt = runtimes.get(id)
  if (!rt) return
  if (rt.handle === null) {
    rt.handle = createXterm({ theme: currentTheme, fontSize: 13, fontFamily: currentFontFamily })
  }
  const { term } = rt.handle

  const patch = (changes: Partial<TerminalSessionMeta>) => {
    set((state) => {
      const meta = state.sessions[id]
      if (!meta) return {}
      return { sessions: { ...state.sessions, [id]: { ...meta, ...changes } } }
    })
  }

  // NOTE on sizing: `term.rows`/`term.cols` reflect real container
  // dimensions on `reconnect()` (the xterm handle was already fitted by a
  // prior TerminalView mount), so the PTY reconnects at the correct size
  // immediately — no resize flash. On the very first `open()` the handle
  // was just constructed and hasn't been fitted to a container yet (that
  // happens a tick later in TerminalView's mount effect), so this first
  // connect still ships xterm's un-fitted default size; the follow-up
  // `sendResize()` from that mount effect corrects it a moment after.
  // Fully closing that gap would mean deferring ticket issuance until
  // after first attach, which would delay the WS handshake behind layout
  // — not worth it for a sub-frame visual correction on local backends,
  // though a slow remote or LAN server can make it briefly visible.
  connectTerminal(
    rt.target,
    {
      onOutput: (data) => term.write(data),
      onExit: () => patch({ status: 'exited', closedReason: 'exit' }),
      onError: () => {
        if (useTerminalStore.getState().sessions[id]?.status === 'connected') {
          patch({ status: 'error', errorMsg: 'Terminal connection error' })
        }
      },
      onClose: () => {
        if (useTerminalStore.getState().sessions[id]?.status === 'connected') {
          patch({ status: 'exited', closedReason: 'exit' })
        }
      },
    },
    { rows: term.rows, cols: term.cols },
  )
    .then((socket) => {
      const live = runtimes.get(id)
      if (!live || live !== rt) {
        // Session was closed while the handshake was in flight.
        socket.close()
        return
      }
      rt.socket = socket
      rt.lastActivityAt = Date.now()
      patch({ status: 'connected', closedReason: undefined, errorMsg: undefined })
    })
    .catch((err: Error) => {
      patch({ status: 'error', errorMsg: err.message })
    })
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  sessions: {},

  open: (target, contextKey) => {
    const id = `term-${++nextOrder}-${Date.now().toString(36)}`
    runtimes.set(id, {
      target,
      handle: null,
      socket: null,
      lastActivityAt: Date.now(),
      attached: false,
      inputTransform: (d) => d,
    })
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: {
          id,
          contextKey,
          title: nextTitle(state.sessions, contextKey),
          status: 'connecting',
          order: nextOrder,
        },
      },
    }))
    ensureReaper(get())
    const rt = runtimes.get(id)!
    // Wire keystrokes once, for the lifetime of the xterm instance.
    connect(id, set)
    rt.handle?.term.onData((data) => get().sendInput(id, data))
    return id
  },

  reconnect: (id) => {
    const rt = runtimes.get(id)
    const meta = get().sessions[id]
    if (!rt || !meta || meta.status === 'connected' || meta.status === 'connecting') return
    try {
      rt.socket?.close()
    } catch {
      // already closed
    }
    rt.socket = null
    rt.lastActivityAt = Date.now()
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: { ...meta, status: 'connecting', closedReason: undefined, errorMsg: undefined },
      },
    }))
    const hadHandle = rt.handle !== null
    connect(id, set)
    if (!hadHandle) {
      rt.handle?.term.onData((data) => get().sendInput(id, data))
    }
  },

  close: (id) => {
    const rt = runtimes.get(id)
    if (rt) teardownRuntime(rt)
    runtimes.delete(id)
    set((state) => {
      const sessions = { ...state.sessions }
      delete sessions[id]
      stopReaperIfEmpty(sessions)
      return { sessions }
    })
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
    set((state) => {
      const meta = state.sessions[id]
      if (!meta) return {}
      return { sessions: { ...state.sessions, [id]: { ...meta, title: trimmed } } }
    })
  },

  syncTheme: (theme) => {
    currentTheme = theme
    for (const rt of runtimes.values()) {
      if (rt.handle) rt.handle.term.options.theme = TERMINAL_THEMES[theme]
    }
  },

  syncFont: (customFont) => {
    currentFontFamily = buildTerminalFontFamily(customFont)
    for (const rt of runtimes.values()) {
      if (rt.handle) rt.handle.term.options.fontFamily = currentFontFamily
    }
  },

  reapIdle: (now = Date.now()) => {
    for (const [id, rt] of runtimes) {
      const meta = get().sessions[id]
      if (!meta || meta.status !== 'connected') continue
      if (rt.attached) continue
      if (now - rt.lastActivityAt <= TERMINAL_IDLE_CLOSE_MS) continue
      teardownRuntime(rt)
      set((state) => {
        const existing = state.sessions[id]
        if (!existing) return {}
        return {
          sessions: {
            ...state.sessions,
            [id]: { ...existing, status: 'exited', closedReason: 'idle' },
          },
        }
      })
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
  nextOrder = 0
  if (reaperTimer !== null) {
    clearInterval(reaperTimer)
    reaperTimer = null
  }
  useTerminalStore.setState({ sessions: {} })
}
