/**
 * useTerminalStore — client-side terminal session registry.
 *
 * Sessions are created OUTSIDE React (term + socket live in a module-level
 * runtime map) so they survive component unmount (tab switches, panel
 * close). The store's idle reaper auto-closes *detached* sessions after
 * TERMINAL_IDLE_CLOSE_MS; attached (visible) sessions are exempt.
 *
 * Protocol v2 (shells survive reloads/disconnects) is covered in the second
 * half: kill-on-close, auto-reattach with backoff, 4409, restore, titles.
 */
import { afterEach, describe, expect, it, beforeEach, mock } from 'bun:test'

import {
  EMPTY_DOCK_PANES,
  openTab,
  paneTabs,
  syncTerminalTabs,
} from '@/components/WorkspacePanel/dock-panes'
import type { DockTab } from '@/components/WorkspacePanel/dock-tabs'
import { useFakeTimers } from '../fake-timers'

// ── Module mocks (must precede store import) ────────────────────────────────

interface FakeTerm {
  write: ReturnType<typeof mock>
  dispose: ReturnType<typeof mock>
  focus: ReturnType<typeof mock>
  onData: ReturnType<typeof mock>
  options: { theme?: unknown; fontFamily?: string }
  rows: number
  cols: number
  element?: HTMLElement
  open: ReturnType<typeof mock>
}

const fn = (impl: (...args: never[]) => unknown) => mock(impl as unknown as (...args: unknown[]) => unknown)

const createdTerms: FakeTerm[] = []
const onDataHandlers: Array<(data: string) => void> = []
/** What `fit.fit()` resizes the fake terminal to (the container's size). */
const fitSize = { rows: 24, cols: 80 }

function makeFakeTerm(): FakeTerm {
  return {
    write: fn(() => {}),
    dispose: fn(() => {}),
    focus: fn(() => {}),
    // Capture the handler so tests can drive real keystrokes through it.
    onData: fn((handler: (data: string) => void) => {
      onDataHandlers.push(handler)
    }),
    options: {},
    rows: 24,
    cols: 80,
    open: fn(() => {}),
  }
}

mock.module('@/components/Terminal/xterm-instance', () => ({
  createXterm: fn((options: { fontFamily: string }) => {
    const term = makeFakeTerm()
    term.options.fontFamily = options.fontFamily
    createdTerms.push(term)
    return {
      term,
      fit: {
        fit: fn(() => {
          term.rows = fitSize.rows
          term.cols = fitSize.cols
        }),
      },
    }
  }),
}))

interface FakeSocket {
  sendInput: ReturnType<typeof mock>
  sendResize: ReturnType<typeof mock>
  close: ReturnType<typeof mock>
  protocol: 1 | 2
  sessionId?: string
}

type TerminalCallbacks = {
  onOutput: (d: string) => void
  onData?: (bytes: Uint8Array, done: () => void) => void
  onGap?: () => void
  onSeq?: (seq: number) => void
  onAttached?: (info: { sessionId: string; seq: number }) => void
  onExit?: () => void
  onBusy?: (busy: boolean) => void
  onError?: (e: Error) => void
  onClose?: (code?: number) => void
}

interface ConnectCall {
  target: { workspace: string }
  callbacks: TerminalCallbacks
  size?: { rows: number; cols: number }
  options?: { sessionId?: string; since?: number }
}

let lastSocket: FakeSocket | null = null
let lastCallbacks: TerminalCallbacks | null = null
let connectProtocol: 1 | 2 = 1
let connectFailures: Error[] = []
let connectDelay: Promise<void> | null = null
let sessionCounter = 0
const connectCalls: ConnectCall[] = []
/** Ordered log of side effects, for "DELETE, then close the socket". */
const events: string[] = []

const failure = (kind?: string, message = 'boom') => Object.assign(new Error(message), kind ? { kind } : {})

mock.module('@/api/terminal', () => ({
  connectTerminal: fn(async (target: ConnectCall['target'], callbacks: TerminalCallbacks, size?: ConnectCall['size'], options?: ConnectCall['options']) => {
    connectCalls.push({ target, callbacks, size, options })
    if (connectDelay) await connectDelay
    const err = connectFailures.shift()
    if (err) throw err
    lastCallbacks = callbacks
    const sessionId = connectProtocol === 2 ? (options?.sessionId ?? `sess-${++sessionCounter}`) : undefined
    const socket: FakeSocket = {
      protocol: connectProtocol,
      sessionId,
      sendInput: fn(() => {}),
      sendResize: fn(() => {}),
      close: fn(() => {
        events.push('socket.close')
      }),
    }
    lastSocket = socket
    if (sessionId) callbacks.onAttached?.({ sessionId, seq: options?.since ?? 0 })
    return socket
  }),
}))

let sessionList: Array<{ session_id: string; workspace: string; created_at: number; attached: boolean; busy: boolean }> = []
let listFailures = 0
const listCalls: string[] = []
const deleteCalls: string[] = []

mock.module('@/api/terminal-sessions', () => ({
  listTerminalSessions: fn(async (workspace: string) => {
    listCalls.push(workspace)
    if (listFailures > 0) {
      listFailures--
      throw new Error('list failed')
    }
    return sessionList.filter((s) => s.workspace === workspace)
  }),
  deleteTerminalSession: fn(async (id: string) => {
    events.push('delete')
    deleteCalls.push(id)
  }),
}))

const {
  useTerminalStore,
  getTerminalRuntime,
  terminalClosedMessage,
  TERMINAL_IDLE_CLOSE_MS,
  TERMINAL_GAP_NOTICE,
  TERMINAL_FIRST_FIT_WAIT_MS,
  TERMINAL_REATTACH_DELAYS_MS,
  TERMINAL_TITLES_KEY,
  _resetTerminalStoreForTests,
} = await import('@/stores/useTerminalStore')

const tick = () => new Promise<void>((r) => setImmediate(r))

/**
 * Let pending connects run. A terminal connects once its view has fitted it,
 * so stand in for the view: attach (which fits) and detach every session
 * whose terminal is waiting for that.
 */
async function settle() {
  await tick()
  for (const id of Object.keys(useTerminalStore.getState().sessions)) {
    const rt = getTerminalRuntime(id)
    if (rt?.handle && !rt.fitted) {
      useTerminalStore.getState().setAttached(id, true)
      useTerminalStore.getState().setAttached(id, false)
    }
  }
  await tick()
  await tick()
}

const WS = '/tmp/ws'
const open = (workspace = WS) => useTerminalStore.getState().open({ workspace }, workspace)
const meta = (id: string) => useTerminalStore.getState().sessions[id]

beforeEach(() => {
  _resetTerminalStoreForTests()
  createdTerms.length = 0
  onDataHandlers.length = 0
  connectCalls.length = 0
  events.length = 0
  deleteCalls.length = 0
  listCalls.length = 0
  lastSocket = null
  lastCallbacks = null
  connectProtocol = 1
  connectFailures = []
  connectDelay = null
  sessionCounter = 0
  sessionList = []
  listFailures = 0
  fitSize.rows = 24
  fitSize.cols = 80
  localStorage.removeItem(TERMINAL_TITLES_KEY)
})

// ── Old protocol (and protocol-independent behaviour) ───────────────────────

describe('useTerminalStore', () => {
  it('open() registers a connecting session, then connects', async () => {
    const id = open()
    expect(meta(id)?.status).toBe('connecting')
    await settle()
    expect(meta(id)?.status).toBe('connected')
    // Server output is written to the persistent term instance.
    lastCallbacks!.onOutput('hello')
    expect(createdTerms[0].write).toHaveBeenCalledWith('hello')
  })

  it('does not build the xterm instance until the lazy chunk resolves', async () => {
    // @xterm/* is ~352 kB minified and must not be parsed on app start, so
    // the handle cannot exist synchronously with open().
    const id = open()

    expect(getTerminalRuntime(id)!.handle).toBeNull()
    expect(meta(id)?.handleReady).toBeFalsy()

    await settle()

    expect(getTerminalRuntime(id)!.handle).not.toBeNull()
    expect(meta(id)?.handleReady).toBe(true)
  })

  it('routes terminal keystrokes to the socket once the handle exists', async () => {
    const s = useTerminalStore.getState()
    const id = open()
    await settle()

    // Exactly one keystroke handler per xterm instance — no double-wiring.
    expect(onDataHandlers).toHaveLength(1)
    onDataHandlers[0]('ls\r')
    expect(lastSocket!.sendInput).toHaveBeenCalledWith('ls\r')

    // Reconnecting an existing handle must not register a second handler.
    lastCallbacks!.onExit!()
    s.reconnect(id)
    await settle()
    expect(onDataHandlers).toHaveLength(1)
  })

  it('numbers titles per context', async () => {
    const s = useTerminalStore.getState()
    const a = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    const b = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    const c = s.open({ workspace: '/workspace/project' }, 'workspace:/workspace/project')
    const sessions = useTerminalStore.getState().sessions
    expect(sessions[a]?.title).toBe('Terminal 1')
    expect(sessions[b]?.title).toBe('Terminal 2')
    expect(sessions[c]?.title).toBe('Terminal 1')
  })

  it('close() tears down socket + term and removes the session', async () => {
    const id = open()
    await settle()
    const socket = lastSocket!
    useTerminalStore.getState().close(id)
    expect(socket.close).toHaveBeenCalled()
    expect(createdTerms[0].dispose).toHaveBeenCalled()
    expect(meta(id)).toBeUndefined()
    expect(getTerminalRuntime(id)).toBeUndefined()
  })

  it('shell exit keeps the session (scrollback) with reason exit', async () => {
    const id = open()
    await settle()
    lastCallbacks!.onExit?.()
    expect(meta(id)?.status).toBe('exited')
    expect(meta(id)?.closedReason).toBe('exit')
    // Term NOT disposed — scrollback stays readable until user closes tab.
    expect(createdTerms[0].dispose).not.toHaveBeenCalled()
  })

  it('reapIdle closes detached sessions past the idle limit', async () => {
    const s = useTerminalStore.getState()
    const id = open()
    await settle()
    s.setAttached(id, false)
    s.reapIdle(Date.now() + TERMINAL_IDLE_CLOSE_MS + 1)
    expect(meta(id)?.status).toBe('exited')
    expect(meta(id)?.closedReason).toBe('idle')
    // Idle close frees the renderer.
    expect(createdTerms[0].dispose).toHaveBeenCalled()
    expect(lastSocket!.close).toHaveBeenCalled()
  })

  it('reapIdle never touches attached or recently-active sessions', async () => {
    const s = useTerminalStore.getState()
    const attached = open()
    await settle()
    s.setAttached(attached, true)
    const fresh = open()
    await settle()
    s.setAttached(fresh, false)
    // Simulate recent activity relative to the reap time below.
    getTerminalRuntime(fresh)!.lastActivityAt = Date.now() + TERMINAL_IDLE_CLOSE_MS

    s.reapIdle(Date.now() + TERMINAL_IDLE_CLOSE_MS + 1)
    // Attached session survives arbitrarily long idle.
    expect(meta(attached)?.status).toBe('connected')
    // Recently-active detached session survives this pass…
    expect(meta(fresh)?.status).toBe('connected')
    // …but is reaped once a full idle window elapses.
    s.reapIdle(Date.now() + 2 * TERMINAL_IDLE_CLOSE_MS + 2)
    expect(meta(fresh)?.status).toBe('exited')
  })

  it('reapIdle never closes a session with a running command', async () => {
    const s = useTerminalStore.getState()
    const id = open()
    await settle()
    s.setAttached(id, false)
    // A detached dev server or build runs with no keystrokes for a long time.
    lastCallbacks!.onBusy!(true)
    expect(meta(id)?.busy).toBe(true)

    s.reapIdle(Date.now() + 10 * TERMINAL_IDLE_CLOSE_MS)
    expect(meta(id)?.status).toBe('connected')
    expect(createdTerms[0].dispose).not.toHaveBeenCalled()

    // Back at the prompt, the idle window applies again.
    lastCallbacks!.onBusy!(false)
    s.reapIdle(Date.now() + 10 * TERMINAL_IDLE_CLOSE_MS)
    expect(meta(id)?.status).toBe('exited')
  })

  it('a shell that exits is no longer busy', async () => {
    const id = open()
    await settle()
    lastCallbacks!.onBusy!(true)
    lastCallbacks!.onExit!()
    expect(meta(id)?.busy).toBeFalsy()
  })

  it('sendInput applies the registered transform and notes activity', async () => {
    const s = useTerminalStore.getState()
    const id = open()
    await settle()
    s.setInputTransform(id, (d) => d.toUpperCase())
    const before = getTerminalRuntime(id)!.lastActivityAt
    await settle()
    s.sendInput(id, 'ls')
    expect(lastSocket!.sendInput).toHaveBeenCalledWith('LS')
    expect(getTerminalRuntime(id)!.lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  it('syncTheme swaps the xterm theme on every live session', async () => {
    const s = useTerminalStore.getState()
    s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    s.open({ workspace: '/workspace/project' }, 'workspace:/workspace/project')
    await settle()
    s.syncTheme('light')
    for (const t of createdTerms) {
      expect((t.options.theme as { background: string }).background).not.toBe('#221c16')
    }
    const lightBg = (createdTerms[0].options.theme as { background: string }).background
    s.syncTheme('dark')
    expect((createdTerms[0].options.theme as { background: string }).background).not.toBe(lightBg)
  })

  it('syncFont swaps the xterm fontFamily on every live session', async () => {
    const s = useTerminalStore.getState()
    s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    s.open({ workspace: '/workspace/project' }, 'workspace:/workspace/project')
    await settle()
    s.syncFont('MesloLGS NF')
    for (const t of createdTerms) {
      expect(t.options.fontFamily).toContain('"MesloLGS NF"')
    }
  })

  it('a newly opened terminal picks up the last-synced font', async () => {
    const s = useTerminalStore.getState()
    s.syncFont('Hack Nerd Font')
    s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await settle()
    expect(createdTerms[0].options.fontFamily).toContain('"Hack Nerd Font"')
  })

  it('reconnect() replaces a dead session in place', async () => {
    const s = useTerminalStore.getState()
    const id = open()
    await settle()
    lastCallbacks!.onExit?.()
    expect(meta(id)?.status).toBe('exited')
    s.reconnect(id)
    expect(meta(id)?.status).toBe('connecting')
    await settle()
    expect(meta(id)?.status).toBe('connected')
    expect(meta(id)?.closedReason).toBeUndefined()
  })

  it('connect failure marks the session error with the message', async () => {
    connectFailures = [failure()]
    const id = open()
    await settle()
    expect(meta(id)?.status).toBe('error')
    expect(meta(id)?.errorMsg).toBe('boom')
  })

  it('rename() sets a custom title, trimmed, ignoring blank input', async () => {
    const s = useTerminalStore.getState()
    const id = open()
    s.rename(id, '  Build watcher  ')
    expect(meta(id)?.title).toBe('Build watcher')
    s.rename(id, '   ')
    // Blank rename is a no-op — keeps the last good title.
    expect(meta(id)?.title).toBe('Build watcher')
  })

  it('sessionsForContext returns only matching sessions in open order', async () => {
    const s = useTerminalStore.getState()
    const a = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    s.open({ workspace: '/workspace/project' }, 'workspace:/workspace/project')
    const b = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    const ids = useTerminalStore
      .getState()
      .sessionsForContext('/tmp/ws')
      .map((m) => m.id)
    expect(ids).toEqual([a, b])
  })
})

// ── Initial size ────────────────────────────────────────────────────────────

describe('first connect size', () => {
  let timers: ReturnType<typeof useFakeTimers>
  beforeEach(() => {
    timers = useFakeTimers()
  })
  afterEach(() => timers.restore())

  it('waits for the view to fit the terminal, then connects at the fitted size', async () => {
    fitSize.rows = 41
    fitSize.cols = 133
    const id = open()
    await tick()
    expect(getTerminalRuntime(id)!.handle).not.toBeNull()
    expect(connectCalls).toHaveLength(0) // no 24×80 connect before the first fit
    useTerminalStore.getState().setAttached(id, true) // the view mounted: fits, then attaches
    await tick()
    expect(connectCalls).toHaveLength(1)
    expect(connectCalls[0].size).toEqual({ rows: 41, cols: 133 })
  })

  it('does not wait forever for a terminal nobody shows', async () => {
    open()
    await tick()
    expect(connectCalls).toHaveLength(0)
    timers.tick(TERMINAL_FIRST_FIT_WAIT_MS)
    await tick()
    expect(connectCalls).toHaveLength(1)
    expect(connectCalls[0].size).toEqual({ rows: 24, cols: 80 })
  })

  it('a hidden terminal borrows the size of the last one that was fitted', async () => {
    fitSize.rows = 50
    fitSize.cols = 160
    const shown = open()
    await tick()
    useTerminalStore.getState().setAttached(shown, true)
    await tick()
    open()
    await tick()
    timers.tick(TERMINAL_FIRST_FIT_WAIT_MS)
    await tick()
    expect(connectCalls[1].size).toEqual({ rows: 50, cols: 160 })
  })

  it('a reconnect of an already-fitted terminal does not wait again', async () => {
    const id = open()
    await tick()
    useTerminalStore.getState().setAttached(id, true)
    await tick()
    lastCallbacks!.onExit!()
    useTerminalStore.getState().reconnect(id)
    await tick()
    expect(connectCalls).toHaveLength(2)
  })
})

// ── Protocol v2 ─────────────────────────────────────────────────────────────

describe('terminal protocol v2', () => {
  let timers: ReturnType<typeof useFakeTimers>
  beforeEach(() => {
    connectProtocol = 2
    timers = useFakeTimers()
  })
  afterEach(() => timers.restore())

  async function openConnected(workspace = WS) {
    const id = open(workspace)
    await settle()
    expect(meta(id)?.status).toBe('connected')
    return id
  }

  describe('session state', () => {
    it('keeps backendId, protocol, seq and busy support from the connection', async () => {
      const id = await openConnected()
      expect(meta(id)?.backendId).toBe('sess-1')
      expect(meta(id)?.protocol).toBe(2)
      expect(getTerminalRuntime(id)!.seq).toBe(0)
      expect(getTerminalRuntime(id)!.busySupported).toBe(false)
      lastCallbacks!.onSeq!(4096)
      expect(getTerminalRuntime(id)!.seq).toBe(4096)
      lastCallbacks!.onBusy!(false)
      expect(getTerminalRuntime(id)!.busySupported).toBe(true)
    })

    it('writes bytes to xterm with the done callback, and a dim line for a gap', async () => {
      await openConnected()
      const done = fn(() => {})
      const bytes = new Uint8Array([104, 105])
      lastCallbacks!.onData!(bytes, done as unknown as () => void)
      expect(createdTerms[0].write).toHaveBeenCalledWith(bytes, done)
      lastCallbacks!.onGap!()
      expect(createdTerms[0].write).toHaveBeenLastCalledWith(TERMINAL_GAP_NOTICE)
      expect(TERMINAL_GAP_NOTICE).toBe('\x1b[2m[earlier output skipped]\x1b[0m\r\n')
    })

    it('the old protocol keeps no backend id', async () => {
      connectProtocol = 1
      const id = await openConnected()
      expect(meta(id)?.backendId).toBeUndefined()
      expect(meta(id)?.protocol).toBe(1)
    })
  })

  describe('closing', () => {
    it('close() DELETEs the session, then closes the socket', async () => {
      const id = await openConnected()
      const socket = lastSocket!
      useTerminalStore.getState().close(id)
      expect(deleteCalls).toEqual(['sess-1'])
      expect(events).toEqual(['delete', 'socket.close'])
      expect(socket.close).toHaveBeenCalled()
      expect(meta(id)).toBeUndefined()
    })

    it('close() on an old-protocol session only closes the socket (that kills the shell)', async () => {
      connectProtocol = 1
      const id = await openConnected()
      useTerminalStore.getState().close(id)
      expect(deleteCalls).toEqual([])
      expect(lastSocket!.close).toHaveBeenCalled()
    })

    it('close() does not DELETE a shell that already ended', async () => {
      const id = await openConnected()
      lastCallbacks!.onExit!()
      useTerminalStore.getState().close(id)
      expect(deleteCalls).toEqual([])
    })

    it('closing a tab for a shell opened in another window does not kill it there', async () => {
      const id = await openConnected()
      lastCallbacks!.onClose!(4409)
      useTerminalStore.getState().close(id)
      expect(deleteCalls).toEqual([])
    })

    it('closing while the handshake is in flight kills the orphan once it attaches', async () => {
      let release!: () => void
      connectDelay = new Promise<void>((r) => (release = r))
      const id = open()
      await tick()
      useTerminalStore.getState().setAttached(id, true)
      await tick()
      expect(connectCalls).toHaveLength(1)
      useTerminalStore.getState().close(id)
      expect(deleteCalls).toEqual([])
      release()
      await tick()
      await tick()
      expect(deleteCalls).toEqual(['sess-1'])
      expect(lastSocket!.close).toHaveBeenCalled()
    })

    it('reapIdle DELETEs the session, then closes the socket', async () => {
      const id = await openConnected()
      const s = useTerminalStore.getState()
      lastCallbacks!.onBusy!(false) // the server reports busy: Unix
      s.setAttached(id, false)
      s.reapIdle(Date.now() + TERMINAL_IDLE_CLOSE_MS + 1)
      expect(meta(id)?.closedReason).toBe('idle')
      expect(events).toEqual(['delete', 'socket.close'])
      expect(deleteCalls).toEqual(['sess-1'])
    })

    it('reapIdle leaves a session alone when the server never sends busy (Windows)', async () => {
      const id = await openConnected()
      const s = useTerminalStore.getState()
      s.setAttached(id, false)
      s.reapIdle(Date.now() + 100 * TERMINAL_IDLE_CLOSE_MS)
      expect(meta(id)?.status).toBe('connected')
      expect(deleteCalls).toEqual([])
      expect(createdTerms[0].dispose).not.toHaveBeenCalled()
    })
  })

  describe('unexpected socket drop', () => {
    it('reattaches with session_id and since=seq after 0.5s and shows connecting meanwhile', async () => {
      const id = await openConnected()
      lastCallbacks!.onSeq!(777)
      lastCallbacks!.onClose!(1006)
      expect(meta(id)?.status).toBe('connecting')
      expect(connectCalls).toHaveLength(1)
      timers.tick(TERMINAL_REATTACH_DELAYS_MS[0] - 1)
      await tick()
      expect(connectCalls).toHaveLength(1)
      timers.tick(1)
      await tick()
      expect(connectCalls).toHaveLength(2)
      expect(connectCalls[1].options).toEqual({ sessionId: 'sess-1', since: 777 })
      expect(meta(id)?.status).toBe('connected')
      expect(meta(id)?.backendId).toBe('sess-1')
      // The shell is the same one: nothing was killed or re-spawned.
      expect(deleteCalls).toEqual([])
    })

    it('backs off 0.5s, 1s, 2s, 4s, 8s, then gives up', async () => {
      expect(TERMINAL_REATTACH_DELAYS_MS).toEqual([500, 1000, 2000, 4000, 8000])
      const id = await openConnected()
      connectFailures = Array.from({ length: 5 }, () => failure())
      lastCallbacks!.onClose!(1006)
      let calls = 1
      for (const delay of TERMINAL_REATTACH_DELAYS_MS) {
        timers.tick(delay - 1)
        await tick()
        expect(connectCalls).toHaveLength(calls) // not yet
        timers.tick(1)
        await tick()
        calls++
        expect(connectCalls).toHaveLength(calls)
      }
      // Five failed tries: stop, and offer Reconnect.
      expect(meta(id)?.status).toBe('error')
      timers.tick(60_000)
      await tick()
      expect(connectCalls).toHaveLength(6)
    })

    it('a successful reattach resets the backoff', async () => {
      await openConnected()
      connectFailures = [failure()]
      lastCallbacks!.onClose!(1006)
      timers.tick(500) // fails
      await tick()
      timers.tick(1000) // succeeds
      await tick()
      expect(connectCalls).toHaveLength(3)
      lastCallbacks!.onClose!(1006)
      timers.tick(499)
      await tick()
      expect(connectCalls).toHaveLength(3)
      timers.tick(1)
      await tick()
      expect(connectCalls).toHaveLength(4)
    })

    it('a 404 on reattach means the shell is gone: exited with reason "lost", no more tries', async () => {
      const id = await openConnected()
      connectFailures = [failure('gone', 'Terminal session not found.')]
      lastCallbacks!.onClose!(1006)
      timers.tick(500)
      await tick()
      expect(meta(id)?.status).toBe('exited')
      expect(meta(id)?.closedReason).toBe('lost')
      timers.tick(60_000)
      await tick()
      expect(connectCalls).toHaveLength(2)
    })

    it('a shell exit is not a drop: no reattach', async () => {
      const id = await openConnected()
      lastCallbacks!.onExit!()
      lastCallbacks!.onClose!(1000)
      timers.tick(60_000)
      await tick()
      expect(meta(id)?.status).toBe('exited')
      expect(meta(id)?.closedReason).toBe('exit')
      expect(connectCalls).toHaveLength(1)
    })

    it('closing the tab cancels a pending reattach', async () => {
      const id = await openConnected()
      lastCallbacks!.onClose!(1006)
      useTerminalStore.getState().close(id)
      timers.tick(60_000)
      await tick()
      expect(connectCalls).toHaveLength(1)
    })

    it('events from a replaced socket are ignored', async () => {
      const id = await openConnected()
      const stale = lastCallbacks!
      stale.onClose!(1006)
      timers.tick(500)
      await tick()
      expect(meta(id)?.status).toBe('connected')
      stale.onClose!(1006) // late close of the old socket
      expect(meta(id)?.status).toBe('connected')
      timers.tick(60_000)
      await tick()
      expect(connectCalls).toHaveLength(2)
    })

    it('a ws error alone does not fail a v2 session (the close decides)', async () => {
      const id = await openConnected()
      lastCallbacks!.onError!(new Error('x'))
      expect(meta(id)?.status).toBe('connected')
    })

    it('spawn failure (4429) is an error, not a retry loop', async () => {
      const id = open()
      connectFailures = [failure('spawn-failed', 'Could not start the shell')]
      await settle()
      expect(meta(id)?.status).toBe('error')
      expect(meta(id)?.errorMsg).toBe('Could not start the shell')
      timers.tick(60_000)
      await tick()
      expect(connectCalls).toHaveLength(1)
    })
  })

  describe('attached elsewhere (4409)', () => {
    it('marks the session as opened in another window, without retrying', async () => {
      const id = await openConnected()
      lastCallbacks!.onClose!(4409)
      expect(meta(id)?.status).toBe('exited')
      expect(meta(id)?.closedReason).toBe('elsewhere')
      timers.tick(60_000)
      await tick()
      expect(connectCalls).toHaveLength(1)
      expect(terminalClosedMessage('elsewhere')).toBe('Opened in another window')
    })

    it('a 4409 during a reattach attempt lands in the same state', async () => {
      const id = await openConnected()
      connectFailures = [failure('elsewhere')]
      lastCallbacks!.onClose!(1006)
      timers.tick(500)
      await tick()
      expect(meta(id)?.closedReason).toBe('elsewhere')
    })

    it('reconnect() reattaches the same shell by backendId at the current seq', async () => {
      const id = await openConnected()
      lastCallbacks!.onSeq!(900)
      lastCallbacks!.onClose!(4409)
      useTerminalStore.getState().reconnect(id)
      expect(meta(id)?.status).toBe('connecting')
      await settle()
      expect(connectCalls[1].options).toEqual({ sessionId: 'sess-1', since: 900 })
      expect(meta(id)?.status).toBe('connected')
      expect(meta(id)?.closedReason).toBeUndefined()
      expect(meta(id)?.backendId).toBe('sess-1')
    })

    it('reconnect() spawns a new shell when the old one no longer exists', async () => {
      const id = await openConnected()
      lastCallbacks!.onClose!(4409)
      connectFailures = [failure('gone')]
      useTerminalStore.getState().reconnect(id)
      await settle()
      expect(connectCalls).toHaveLength(3)
      expect(connectCalls[2].options).toBeUndefined()
      expect(meta(id)?.status).toBe('connected')
      expect(meta(id)?.backendId).toBe('sess-2')
      expect(getTerminalRuntime(id)!.seq).toBe(0)
    })

    it('reconnect() after the shell ended or was lost spawns a fresh shell', async () => {
      const id = await openConnected()
      lastCallbacks!.onExit!()
      useTerminalStore.getState().reconnect(id)
      await settle()
      expect(connectCalls[1].options).toBeUndefined()
      expect(meta(id)?.backendId).toBe('sess-2')
    })

    it('reconnect() after giving up on a drop tries the same shell first', async () => {
      const id = await openConnected()
      connectFailures = Array.from({ length: 5 }, () => failure())
      lastCallbacks!.onClose!(1006)
      for (const delay of TERMINAL_REATTACH_DELAYS_MS) {
        timers.tick(delay)
        await tick()
      }
      expect(meta(id)?.status).toBe('error')
      useTerminalStore.getState().reconnect(id)
      await settle()
      expect(connectCalls.at(-1)?.options).toMatchObject({ sessionId: 'sess-1' })
      expect(meta(id)?.status).toBe('connected')
    })
  })

  describe('restore after reload', () => {
    const info = (session_id: string, extra: Partial<(typeof sessionList)[number]> = {}) => ({
      session_id,
      workspace: WS,
      created_at: 1,
      attached: false,
      busy: false,
      ...extra,
    })

    it('attaches unattached sessions from the list with since=0, without taking focus', async () => {
      sessionList = [info('a', { created_at: 1 }), info('b', { created_at: 2, busy: true })]
      await useTerminalStore.getState().restoreSessions(WS)
      // No view ever shows these: they connect on the fit fallback alone.
      await tick()
      timers.tick(TERMINAL_FIRST_FIT_WAIT_MS)
      await tick()
      await tick()
      const metas = useTerminalStore.getState().sessionsForContext(WS)
      expect(metas.map((m) => m.backendId)).toEqual(['a', 'b'])
      expect(metas.every((m) => m.status === 'connected')).toBe(true)
      expect(connectCalls.map((c) => c.options)).toEqual([
        { sessionId: 'a', since: 0 },
        { sessionId: 'b', since: 0 },
      ])
      expect(metas[1].busy).toBe(true)
      // Restoring never focuses a terminal or marks it as shown.
      for (const t of createdTerms) expect(t.focus).not.toHaveBeenCalled()
      for (const m of metas) expect(getTerminalRuntime(m.id)!.attached).toBe(false)
    })

    it('skips sessions attached elsewhere, ones already in the store, and other workspaces', async () => {
      const existing = await openConnected() // backendId sess-1
      sessionList = [
        info('sess-1'),
        info('taken', { attached: true }),
        info('other', { workspace: '/other' }),
        info('free'),
      ]
      await useTerminalStore.getState().restoreSessions(WS)
      await settle()
      const ids = useTerminalStore.getState().sessionsForContext(WS).map((m) => m.backendId)
      expect(ids).toEqual(['sess-1', 'free'])
      expect(meta(existing)?.backendId).toBe('sess-1')
    })

    it('lists once per workspace, and retries after a failed list', async () => {
      listFailures = 1
      await useTerminalStore.getState().restoreSessions(WS)
      expect(useTerminalStore.getState().sessionsForContext(WS)).toHaveLength(0)
      await useTerminalStore.getState().restoreSessions(WS)
      await useTerminalStore.getState().restoreSessions(WS)
      expect(listCalls).toEqual([WS, WS])
      await useTerminalStore.getState().restoreSessions('/elsewhere')
      expect(listCalls).toEqual([WS, WS, '/elsewhere'])
    })

    it('connects a restored terminal that nobody shows at the last fitted size, without waiting for a view', async () => {
      fitSize.rows = 45
      fitSize.cols = 150
      const shown = open()
      await tick()
      useTerminalStore.getState().setAttached(shown, true)
      await tick()
      sessionList = [info('a')]
      await useTerminalStore.getState().restoreSessions(WS)
      await tick()
      timers.tick(TERMINAL_FIRST_FIT_WAIT_MS)
      await tick()
      const call = connectCalls.find((c) => c.options?.sessionId === 'a')!
      expect(call.size).toEqual({ rows: 45, cols: 150 })
    })

    it('a restored session that is gone (404) or taken (4409) in the meantime is dropped quietly', async () => {
      sessionList = [info('gone'), info('taken'), info('ok')]
      connectFailures = [failure('gone'), failure('elsewhere')]
      await useTerminalStore.getState().restoreSessions(WS)
      await settle()
      const metas = useTerminalStore.getState().sessionsForContext(WS)
      expect(metas.map((m) => m.backendId)).toEqual(['ok'])
    })

    it('a restored session whose connect fails transiently retries with backoff', async () => {
      sessionList = [info('a')]
      connectFailures = [failure()]
      await useTerminalStore.getState().restoreSessions(WS)
      await settle()
      const [m] = useTerminalStore.getState().sessionsForContext(WS)
      expect(m.status).toBe('connecting')
      timers.tick(500)
      await tick()
      expect(meta(m.id)?.status).toBe('connected')
      expect(connectCalls.at(-1)?.options).toEqual({ sessionId: 'a', since: 0 })
    })

    it('restored shells join the dock tabs without stealing the active tab', async () => {
      sessionList = [info('a'), info('b')]
      await useTerminalStore.getState().restoreSessions(WS)
      await settle()
      const fileTab: DockTab = {
        id: 'file:/x',
        type: 'file',
        title: 'x',
        file: { path: '/x', name: 'x', size: 1, mtime: 0, mime: 'text/plain' },
      }
      const dock = openTab(EMPTY_DOCK_PANES, fileTab)
      const metas = useTerminalStore.getState().sessionsForContext(WS)
      const next = syncTerminalTabs(dock, metas)
      const pane = next.focused
      expect(paneTabs(next, pane).map((t) => t.id)).toEqual([
        'file:/x',
        ...metas.map((m) => `terminal:${m.id}`),
      ])
      expect(next.panes[pane].active).toBe('file:/x')
    })
  })

  describe('persisted titles', () => {
    const stored = () =>
      JSON.parse(localStorage.getItem(TERMINAL_TITLES_KEY) ?? '{}') as Record<string, { title: string; workspace: string }>

    it('renaming a v2 session persists the title by backend session id', async () => {
      const id = await openConnected()
      useTerminalStore.getState().rename(id, 'Dev server')
      expect(TERMINAL_TITLES_KEY).toBe('oad:terminal-titles')
      expect(stored()['sess-1']).toEqual({ title: 'Dev server', workspace: WS })
    })

    it('a rename made before the shell attached is persisted once it has an id', async () => {
      const id = open()
      useTerminalStore.getState().rename(id, 'Early')
      expect(stored()).toEqual({})
      await settle()
      expect(stored()['sess-1']?.title).toBe('Early')
    })

    it('a restored session gets its persisted title back', async () => {
      localStorage.setItem(TERMINAL_TITLES_KEY, JSON.stringify({ a: { title: 'Logs', workspace: WS } }))
      sessionList = [
        { session_id: 'a', workspace: WS, created_at: 1, attached: false, busy: false },
        { session_id: 'b', workspace: WS, created_at: 2, attached: false, busy: false },
      ]
      await useTerminalStore.getState().restoreSessions(WS)
      const metas = useTerminalStore.getState().sessionsForContext(WS)
      expect(metas.map((m) => m.title)).toEqual(['Logs', 'Terminal 1'])
    })

    it('prunes titles of this workspace whose session is gone, keeping other workspaces and live ones', async () => {
      localStorage.setItem(
        TERMINAL_TITLES_KEY,
        JSON.stringify({
          live: { title: 'Live', workspace: WS },
          dead: { title: 'Dead', workspace: WS },
          foreign: { title: 'Foreign', workspace: '/other' },
        }),
      )
      sessionList = [{ session_id: 'live', workspace: WS, created_at: 1, attached: true, busy: false }]
      await useTerminalStore.getState().restoreSessions(WS)
      expect(Object.keys(stored()).sort()).toEqual(['foreign', 'live'])
    })

    it('closing a tab forgets its persisted title', async () => {
      const id = await openConnected()
      useTerminalStore.getState().rename(id, 'Temp')
      useTerminalStore.getState().close(id)
      expect(stored()).toEqual({})
    })

    it('survives corrupt storage', async () => {
      localStorage.setItem(TERMINAL_TITLES_KEY, '{nope')
      const id = await openConnected()
      useTerminalStore.getState().rename(id, 'Fine')
      expect(stored()['sess-1']?.title).toBe('Fine')
    })
  })
})

describe('terminalClosedMessage', () => {
  it('says the shell ended for every reason except "another window"', () => {
    expect(terminalClosedMessage('exit')).toBe('Session ended')
    expect(terminalClosedMessage(undefined)).toBe('Session ended')
    expect(terminalClosedMessage('idle')).toBe('Session ended — closed after 15 min idle')
    expect(terminalClosedMessage('lost')).toMatch(/^Session ended/)
    expect(terminalClosedMessage('lost')).toMatch(/no longer running/)
    expect(terminalClosedMessage('elsewhere')).toBe('Opened in another window')
  })
})
