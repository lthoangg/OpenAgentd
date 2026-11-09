/**
 * Interleavings of one session stream link (`connectStream`) with the things
 * that replace it: a newer link for the same session, a session switch, and
 * the page going away. Each stale input must leave the view that replaced
 * its link untouched; the current link keeps the optimistic `isConnected`.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test"

type Callbacks = {
  onEvent: (type: string, data: unknown) => void
  onDone: () => void
  onError: (err: Error) => void
}

function isCallbacks(value: unknown): value is Callbacks {
  return typeof value === "object" && value !== null
    && "onEvent" in value && typeof value.onEvent === "function"
    && "onDone" in value && typeof value.onDone === "function"
    && "onError" in value && typeof value.onError === "function"
}

const links: Callbacks[] = []
/** `agentStream(sessionId, callbacks, signal)`: keeps each link's callbacks. */
const mockAgentStream = mock((...args: unknown[]) => {
  const callbacks = args[1]
  if (!isCallbacks(callbacks)) throw new Error("agentStream requires stream callbacks")
  links.push(callbacks)
})
mock.module("@/api/client", () => ({
  agentStream: mockAgentStream,
  sessionHistorySince: mock(async () => ({ lead: { messages: [] }, members: [], truncated: false })),
  sessionHistory: mock(async () => { throw new Error("not used") }),
  agentStatus: mock(async () => ({ lead: null, members: [] })),
}))

import { useAgentStore } from "@/stores/useAgentStore"
import { createDefaultAgentStream } from "@/stores/useAgentStore/defaults"

const REAL_SET_TIMEOUT = globalThis.setTimeout
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout

/**
 * Global timers the test runs by hand: the delta flush and the reconnect
 * back-off. Handles are plain numbers: the store keeps the reconnect handle
 * in its (frozen) state.
 */
let timers: { callback: () => void; ms: number; cleared: boolean }[] = []
function runTimers(ms: number) {
  for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
    timer.cleared = true
    timer.callback()
  }
}

function lead() {
  return useAgentStore.getState().agentStreams.lead
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, release: async () => { resolve(); await promise; await Promise.resolve() } }
}

/** Another session took the view (as `beginSession` does), keeping the agent names. */
function switchSession(sessionId: string) {
  useAgentStore.setState((state) => {
    state.sessionId = sessionId
    state._sessionGeneration += 1
    state.isConnected = false
    state._abortController = null
    state.agentStreams.lead.currentBlocks = []
  })
}

beforeEach(() => {
  links.length = 0
  mockAgentStream.mockClear()
  timers = []
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    timers.push({ callback, ms: ms ?? 0, cleared: false })
    return timers.length as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: unknown) => {
    const timer = typeof handle === "number" ? timers[handle - 1] : undefined
    if (timer) timer.cleared = true
  }) as typeof clearTimeout
  useAgentStore.setState({
    sessionId: "s1",
    _workspace: "/repo",
    leadName: "lead",
    agentNames: ["lead"],
    isAgentWorking: true,
    isConnected: false,
    pendingQuestion: null,
    error: null,
    _abortController: null,
    _reconnectTimer: null,
    _reconnectAttempts: 0,
    _unloading: false,
    _sessionGeneration: 1,
    _syncedThrough: null,
    cacheInvalidations: [],
    loadSession: mock(async () => {}),
    agentStreams: {
      lead: { ...createDefaultAgentStream(), status: "working" },
    },
  })
})

afterEach(() => {
  useAgentStore.getState()._abortController?.abort()
  globalThis.setTimeout = REAL_SET_TIMEOUT
  globalThis.clearTimeout = REAL_CLEAR_TIMEOUT
})

describe("session stream link: optimistic connection", () => {
  it("counts as connected from the attach, before any frame arrives", () => {
    useAgentStore.getState().connectStream()
    expect(useAgentStore.getState().isConnected).toBe(true)
    links[0].onEvent("agent_status", { agent: "lead", status: "working" })
    expect(useAgentStore.getState().isConnected).toBe(true)
  })

  it("counts as connected while its frames wait for the history read", () => {
    const history = deferred()
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    links[0].onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "call-1" })
    expect(useAgentStore.getState().isConnected).toBe(true)
    expect(lead().currentBlocks).toHaveLength(0)
  })
})

describe("session stream link: held frames", () => {
  it("drops the frames a replaced link held, and leaves the new link connected", async () => {
    const history = deferred()
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    links[0].onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "old" })
    links[0].onDone()
    const replacement = useAgentStore.getState().connectStream()

    await history.release()
    expect(lead().currentBlocks).toHaveLength(0)
    expect(mockAgentStream).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState()._abortController).toBe(replacement)
    expect(useAgentStore.getState().isConnected).toBe(true)
  })

  it("does not apply held frames to the session that replaced theirs", async () => {
    const history = deferred()
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    links[0].onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "old" })
    links[0].onDone()
    switchSession("s2")

    await history.release()
    expect(lead().currentBlocks).toHaveLength(0)
    expect(useAgentStore.getState().cacheInvalidations).toEqual([])
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
  })

  it("does not show or retry a held error from a replaced link", async () => {
    const history = deferred()
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    links[0].onError(new Error("stream broke"))
    useAgentStore.getState().connectStream()

    await history.release()
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState()._reconnectTimer).toBeNull()
    expect(useAgentStore.getState().isConnected).toBe(true)
  })
})

describe("session stream link: buffered deltas", () => {
  it("discards deltas still buffered when the session changes", () => {
    useAgentStore.getState().connectStream()
    links[0].onEvent("message", { agent: "lead", text: "from s1" })
    switchSession("s2")

    runTimers(16)
    expect(lead().currentBlocks).toHaveLength(0)
  })

  it("applies buffered deltas before a structural frame of the same link", () => {
    useAgentStore.getState().connectStream()
    links[0].onEvent("message", { agent: "lead", text: "before the tool" })
    links[0].onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "call-1" })
    expect(lead().currentBlocks.map((b) => b.type)).toEqual(["text", "tool"])
    expect(lead().currentBlocks[0].content).toBe("before the tool")
  })
})

describe("session stream link: closes and retries", () => {
  it("shows a non-network failure of the current link during a turn and stops calling it connected", () => {
    useAgentStore.getState().connectStream()
    links[0].onError(new Error("Stream failed: 500"))

    expect(useAgentStore.getState().error).toBe("Stream failed: 500")
    expect(useAgentStore.getState().isConnected).toBe(false)
    expect(useAgentStore.getState()._reconnectTimer).toBeNull()
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
  })

  it("stops calling an idle session's link connected after a non-network failure, without an error", () => {
    useAgentStore.setState({ isAgentWorking: false })
    useAgentStore.getState().connectStream()
    links[0].onError(new Error("Stream failed: 500"))

    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isConnected).toBe(false)
    expect(useAgentStore.getState()._reconnectTimer).toBeNull()
  })

  it("does not reconnect from a back-off timer once the session was reopened as new", () => {
    useAgentStore.getState().connectStream()
    links[0].onError(new TypeError("Load failed"))
    expect(useAgentStore.getState()._reconnectAttempts).toBe(1)
    // Same session id, new generation: a reload of the session that left the old timer behind.
    useAgentStore.setState((state) => { state._sessionGeneration += 1 })

    runTimers(1_500)
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
  })

  it("treats a close while the page unloads as the end of the turn, without reopening", () => {
    useAgentStore.setState({ _unloading: true })
    useAgentStore.getState().connectStream()
    links[0].onEvent("agent_status", { agent: "lead", status: "working" })
    links[0].onDone()

    expect(mockAgentStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().isConnected).toBe(false)
    expect(useAgentStore.getState().cacheInvalidations).toContainEqual({ kind: "session_running", sessionId: "s1", running: false })
  })

  it("ignores a close and an error from a link the session switch left behind", () => {
    useAgentStore.getState().connectStream()
    switchSession("s2")
    useAgentStore.getState().connectStream()

    links[0].onError(new Error("old link broke"))
    links[0].onDone()
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isConnected).toBe(true)
    expect(useAgentStore.getState().cacheInvalidations).toEqual([])
    expect(mockAgentStream).toHaveBeenCalledTimes(2)
  })

  it("keeps the reconnect back-off attempts across a link that closed silently", () => {
    useAgentStore.getState().connectStream()
    links[0].onDone()
    expect(useAgentStore.getState()._reconnectAttempts).toBe(1)
    runTimers(1_500)
    links[1].onDone()
    expect(useAgentStore.getState()._reconnectAttempts).toBe(2)
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toContain(3_000)
  })
})
