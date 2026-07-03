/**
 * useTerminalStore — client-side terminal session registry.
 *
 * Sessions are created OUTSIDE React (term + socket live in a module-level
 * runtime map) so they survive component unmount (tab switches, panel
 * close). The store's idle reaper auto-closes *detached* sessions after
 * TERMINAL_IDLE_CLOSE_MS; attached (visible) sessions are exempt.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test'

// ── Module mocks (must precede store import) ────────────────────────────────

interface FakeTerm {
  write: ReturnType<typeof mock>
  dispose: ReturnType<typeof mock>
  focus: ReturnType<typeof mock>
  onData: ReturnType<typeof mock>
  options: { theme?: unknown }
  rows: number
  cols: number
  element?: HTMLElement
  open: ReturnType<typeof mock>
}

const createdTerms: FakeTerm[] = []

function makeFakeTerm(): FakeTerm {
  return {
    write: mock(() => {}),
    dispose: mock(() => {}),
    focus: mock(() => {}),
    onData: mock(() => {}),
    options: {},
    rows: 24,
    cols: 80,
    open: mock(() => {}),
  }
}

mock.module('@/components/Terminal/xterm-instance', () => ({
  createXterm: mock(() => {
    const term = makeFakeTerm()
    createdTerms.push(term)
    return { term, fit: { fit: mock(() => {}) } }
  }),
}))

interface FakeSocket {
  sendInput: ReturnType<typeof mock>
  sendResize: ReturnType<typeof mock>
  close: ReturnType<typeof mock>
}

type TerminalCallbacks = {
  onOutput: (d: string) => void
  onExit?: () => void
  onError?: (e: Error) => void
  onClose?: () => void
}

let lastSocket: FakeSocket | null = null
let lastCallbacks: TerminalCallbacks | null = null
let connectShouldFail = false

mock.module('@/api/terminal', () => ({
  connectTerminal: mock(async (_target: unknown, callbacks: unknown) => {
    if (connectShouldFail) throw new Error('boom')
    lastCallbacks = callbacks as TerminalCallbacks
    lastSocket = {
      sendInput: mock(() => {}),
      sendResize: mock(() => {}),
      close: mock(() => {}),
    }
    return lastSocket
  }),
}))

const { useTerminalStore, getTerminalRuntime, TERMINAL_IDLE_CLOSE_MS, _resetTerminalStoreForTests } =
  await import('@/stores/useTerminalStore')

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  _resetTerminalStoreForTests()
  createdTerms.length = 0
  lastSocket = null
  lastCallbacks = null
  connectShouldFail = false
})

describe('useTerminalStore', () => {
  it('open() registers a connecting session, then connects', async () => {
    const id = useTerminalStore.getState().open({ workspace: '/tmp/ws' }, '/tmp/ws')
    expect(useTerminalStore.getState().sessions[id]?.status).toBe('connecting')
    await flush()
    expect(useTerminalStore.getState().sessions[id]?.status).toBe('connected')
    // Server output is written to the persistent term instance.
    lastCallbacks!.onOutput('hello')
    expect(createdTerms[0].write).toHaveBeenCalledWith('hello')
  })

  it('numbers titles per context', async () => {
    const s = useTerminalStore.getState()
    const a = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    const b = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    const c = s.open({ sessionId: 'sid-1' }, 'session:sid-1')
    const sessions = useTerminalStore.getState().sessions
    expect(sessions[a]?.title).toBe('Terminal 1')
    expect(sessions[b]?.title).toBe('Terminal 2')
    expect(sessions[c]?.title).toBe('Terminal 1')
  })

  it('close() tears down socket + term and removes the session', async () => {
    const id = useTerminalStore.getState().open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    const socket = lastSocket!
    useTerminalStore.getState().close(id)
    expect(socket.close).toHaveBeenCalled()
    expect(createdTerms[0].dispose).toHaveBeenCalled()
    expect(useTerminalStore.getState().sessions[id]).toBeUndefined()
    expect(getTerminalRuntime(id)).toBeUndefined()
  })

  it('shell exit keeps the session (scrollback) with reason exit', async () => {
    const id = useTerminalStore.getState().open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    lastCallbacks!.onExit?.()
    const meta = useTerminalStore.getState().sessions[id]
    expect(meta?.status).toBe('exited')
    expect(meta?.closedReason).toBe('exit')
    // Term NOT disposed — scrollback stays readable until user closes tab.
    expect(createdTerms[0].dispose).not.toHaveBeenCalled()
  })

  it('reapIdle closes detached sessions past the idle limit', async () => {
    const s = useTerminalStore.getState()
    const id = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    s.setAttached(id, false)
    const now = Date.now() + TERMINAL_IDLE_CLOSE_MS + 1
    s.reapIdle(now)
    const meta = useTerminalStore.getState().sessions[id]
    expect(meta?.status).toBe('exited')
    expect(meta?.closedReason).toBe('idle')
    // Idle close frees the renderer.
    expect(createdTerms[0].dispose).toHaveBeenCalled()
    expect(lastSocket!.close).toHaveBeenCalled()
  })

  it('reapIdle never touches attached or recently-active sessions', async () => {
    const s = useTerminalStore.getState()
    const attached = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    s.setAttached(attached, true)
    const fresh = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    s.setAttached(fresh, false)
    // Simulate recent activity relative to the reap time below.
    getTerminalRuntime(fresh)!.lastActivityAt = Date.now() + TERMINAL_IDLE_CLOSE_MS

    s.reapIdle(Date.now() + TERMINAL_IDLE_CLOSE_MS + 1)
    // Attached session survives arbitrarily long idle.
    expect(useTerminalStore.getState().sessions[attached]?.status).toBe('connected')
    // Recently-active detached session survives this pass…
    expect(useTerminalStore.getState().sessions[fresh]?.status).toBe('connected')
    // …but is reaped once a full idle window elapses.
    s.reapIdle(Date.now() + 2 * TERMINAL_IDLE_CLOSE_MS + 2)
    expect(useTerminalStore.getState().sessions[fresh]?.status).toBe('exited')
  })

  it('sendInput applies the registered transform and notes activity', async () => {
    const s = useTerminalStore.getState()
    const id = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    s.setInputTransform(id, (d) => d.toUpperCase())
    const before = getTerminalRuntime(id)!.lastActivityAt
    await flush()
    s.sendInput(id, 'ls')
    expect(lastSocket!.sendInput).toHaveBeenCalledWith('LS')
    expect(getTerminalRuntime(id)!.lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  it('syncTheme swaps the xterm theme on every live session', async () => {
    const s = useTerminalStore.getState()
    s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    s.open({ sessionId: 'sid-1' }, 'session:sid-1')
    await flush()
    s.syncTheme('light')
    for (const t of createdTerms) {
      expect((t.options.theme as { background: string }).background).not.toBe('#1e1c1a')
    }
    const lightBg = (createdTerms[0].options.theme as { background: string }).background
    s.syncTheme('dark')
    expect((createdTerms[0].options.theme as { background: string }).background).not.toBe(lightBg)
  })

  it('reconnect() replaces a dead session in place', async () => {
    const s = useTerminalStore.getState()
    const id = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    lastCallbacks!.onExit?.()
    expect(useTerminalStore.getState().sessions[id]?.status).toBe('exited')
    s.reconnect(id)
    expect(useTerminalStore.getState().sessions[id]?.status).toBe('connecting')
    await flush()
    expect(useTerminalStore.getState().sessions[id]?.status).toBe('connected')
    expect(useTerminalStore.getState().sessions[id]?.closedReason).toBeUndefined()
  })

  it('connect failure marks the session error with the message', async () => {
    connectShouldFail = true
    const id = useTerminalStore.getState().open({ workspace: '/tmp/ws' }, '/tmp/ws')
    await flush()
    const meta = useTerminalStore.getState().sessions[id]
    expect(meta?.status).toBe('error')
    expect(meta?.errorMsg).toBe('boom')
  })

  it('rename() sets a custom title, trimmed, ignoring blank input', async () => {
    const s = useTerminalStore.getState()
    const id = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    s.rename(id, '  Build watcher  ')
    expect(useTerminalStore.getState().sessions[id]?.title).toBe('Build watcher')
    s.rename(id, '   ')
    // Blank rename is a no-op — keeps the last good title.
    expect(useTerminalStore.getState().sessions[id]?.title).toBe('Build watcher')
  })

  it('sessionsForContext returns only matching sessions in open order', async () => {
    const s = useTerminalStore.getState()
    const a = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    s.open({ sessionId: 'sid-1' }, 'session:sid-1')
    const b = s.open({ workspace: '/tmp/ws' }, '/tmp/ws')
    const ids = useTerminalStore
      .getState()
      .sessionsForContext('/tmp/ws')
      .map((m) => m.id)
    expect(ids).toEqual([a, b])
  })
})
