/**
 * Stopping the agent and the session stream connection.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mockPostAgentChat, mockTeamStream, mockSessionHistory, makeStream, makeMessageResponse, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"

beforeEach(resetAsyncStore)

// ── stopAgent ────────────────────────────────────────────────────────────────

describe("stopAgent", () => {
  it("reloads immediately after the interrupt without waiting for the trailing done", async () => {
    useAgentStore.setState({
      sessionId: "session-a",
      isAgentWorking: true,
      _workspace: "/repo/a",
    })

    // The reload no longer waits on a timer for the turn to "settle": a
    // belated `done` can no longer duplicate the turn (it recognises that a
    // canonical reload already absorbed it), so Stop stays responsive.
    await useAgentStore.getState().stopAgent()

    // A plain Stop (the last argument is keepGoal).
    expect(mockPostAgentChat.mock.calls[0]).toEqual([null, "session-a", true, "/repo/a", undefined, undefined, undefined, false, undefined, undefined, false])
    expect(mockSessionHistory).toHaveBeenCalledWith("session-a")
    expect(useAgentStore.getState()._workspace).toBe("/repo/a")
  })

  it("asks the server to keep the goal when stopping for Stop and send", async () => {
    useAgentStore.setState({ sessionId: "session-a", isAgentWorking: true, _workspace: "/repo/a" })

    await useAgentStore.getState().stopAgent({ keepGoal: true })

    expect(mockPostAgentChat.mock.calls[0]).toEqual([null, "session-a", true, "/repo/a", undefined, undefined, undefined, false, undefined, undefined, true])
  })

  it("does not duplicate message A + the agent's turn when Stop is clicked mid-stream", async () => {
    // Reproduces: user sends a message, the agent streams thinking/tool/
    // message blocks, the user clicks Stop. The interrupt POST only *signals*
    // cancellation — the backend keeps running briefly before it actually
    // unwinds, persists the interrupted turn, and emits the trailing `done`
    // SSE event. The post-stop reload must not race that trailing `done`.
    // Live blocks are always stamped from the *client* clock (see the
    // `new Date()` sites in sse-reducer/pending-slice), so they predate the
    // reload's own client-clock `fetchStartedAt`. Server/client skew cannot
    // apply here — it only affects comparisons against persisted server rows.
    const streamedAt = new Date(Date.now() - 1000)
    useAgentStore.setState({
      sessionId: "sess-1",
      isAgentWorking: true,
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentBlocks: [
            { id: "u1", type: "user", content: "message A", timestamp: streamedAt },
            { id: "b1", type: "thinking", content: "thinking...", timestamp: streamedAt },
            { id: "b2", type: "tool", content: "tool call", timestamp: streamedAt },
            { id: "b3", type: "text", content: "final answer", timestamp: streamedAt },
          ],
        }),
      },
    })

    mockSessionHistory.mockImplementation(() => Promise.resolve({
      lead: {
        id: "lead-sess",
        agent_name: "lead",
        title: null,
        created_at: null,
        updated_at: null,
        sub_sessions: [],
        messages: [
          makeMessageResponse({ id: "m1", role: "user", content: "message A", created_at: "2024-01-01T00:00:00Z" }),
          makeMessageResponse({ id: "m2", role: "assistant", content: "final answer", created_at: "2024-01-01T00:00:03Z" }),
        ],
      },
      members: [],
      has_more: false,
      next_cursor: null,
    }))

    // The reload runs while the turn is still live client-side, so it
    // replaces `blocks` with the server's canonical (already-persisted) turn
    // while preserving the live `currentBlocks`.
    await useAgentStore.getState().stopAgent()

    // The backend finally finishes cancelling and the trailing `done` event
    // lands — long after the reload. Because the reload already absorbed this
    // exact turn, `done` must drop the now-redundant live blocks rather than
    // append them a second time. No timing window is involved.
    useAgentStore.getState()._handleSSEEvent("done", {})

    const finalBlocks = useAgentStore.getState().agentStreams.lead.blocks
    const userBlocks = finalBlocks.filter((b) => b.type === "user" && b.content === "message A")
    const answerBlocks = finalBlocks.filter((b) => b.content === "final answer")
    expect(userBlocks).toHaveLength(1)
    expect(answerBlocks).toHaveLength(1)
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
  })

  it("still commits a brand-new turn that starts while the post-stop reload is in flight", async () => {
    // Guard against over-absorbing: if a *new* turn begins after the history
    // snapshot was taken, its blocks are genuinely absent from that snapshot
    // and `done` must still commit them.
    useAgentStore.setState({
      sessionId: "sess-1",
      isAgentWorking: true,
      leadName: "lead",
      agentNames: ["lead"],
      _pendingMessages: [{ id: "pm-b", sessionId: "sess-1", content: "message B" }],
      _workspace: "/repo/a",
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentBlocks: [
            { id: "b3", type: "text", content: "final answer", timestamp: new Date(Date.now() - 1000) },
          ],
        }),
      },
    })

    mockSessionHistory.mockImplementation(async () => {
      // A queued message is released into a new turn while the fetch is in
      // flight — this content postdates the snapshot below.
      useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
        agent: "lead", message_ids: ["pm-b"],
      })
      useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "answer B" })
      return {
        lead: {
          id: "lead-sess", agent_name: "lead", title: null, created_at: null,
          updated_at: null, sub_sessions: [],
          messages: [
            makeMessageResponse({ id: "m2", role: "assistant", content: "final answer", created_at: "2024-01-01T00:00:03Z" }),
          ],
        },
        members: [], has_more: false, next_cursor: null,
      }
    })

    await useAgentStore.getState().stopAgent()
    useAgentStore.getState()._handleSSEEvent("done", {})

    const finalBlocks = useAgentStore.getState().agentStreams.lead.blocks
    expect(finalBlocks.filter((b) => b.content === "final answer")).toHaveLength(1)
    expect(finalBlocks.filter((b) => b.content === "message B")).toHaveLength(1)
    expect(finalBlocks.filter((b) => b.content === "answer B")).toHaveLength(1)
  })
})

// ── connectStream ─────────────────────────────────────────────────────────────

describe("connectStream", () => {
  // Reconnect back-off is timer-driven, so most tests below stub the global
  // timers to run callbacks synchronously. Restore them here rather than at the
  // end of each test: a stub that escapes this file replaces `setTimeout`
  // process-wide, and because Bun runs files sequentially in one process
  // without `--parallel`, every later file that awaits a timer hangs until the
  // 5s test timeout. One forgotten restore is enough, so no test owns its own.
  const REAL_SET_TIMEOUT = globalThis.setTimeout
  const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout

  afterEach(() => {
    globalThis.setTimeout = REAL_SET_TIMEOUT
    globalThis.clearTimeout = REAL_CLEAR_TIMEOUT
  })

  it("calls agentStream with the current sessionId", () => {
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })
    useAgentStore.getState().connectStream()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(mockTeamStream.mock.calls[0][0]).toBe("stream-sid")
  })

  // Every store update re-runs every subscribed selector in the app.
  it("opens a stream with a single store update, even over a pending reconnect", () => {
    const pending = REAL_SET_TIMEOUT(() => {}, 60_000)
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true, _reconnectTimer: pending })
    let notifications = 0
    const unsubscribe = useAgentStore.subscribe(() => { notifications += 1 })
    useAgentStore.getState().connectStream()
    unsubscribe()
    expect(notifications).toBe(1)
    expect(useAgentStore.getState()).toMatchObject({ isConnected: true, _reconnectTimer: null })
  })

  it("coalesces streaming text deltas into one store update per frame window", () => {
    let scheduled: (() => void) | null = null
    globalThis.setTimeout = ((callback: TimerHandler) => {
      scheduled = callback as () => void
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => { scheduled = null }) as typeof clearTimeout

    useAgentStore.setState({ sessionId: "stream-sid" })
    let callbacks!: { onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()

    let notifications = 0
    const unsubscribe = useAgentStore.subscribe(() => { notifications += 1 })
    callbacks.onEvent("message", { agent: "lead", text: "one " })
    callbacks.onEvent("message", { agent: "lead", text: "two " })
    callbacks.onEvent("message", { agent: "lead", text: "three" })

    // Deltas received in the same frame window should not produce one
    // immer snapshot + subscriber notification each.
    expect(notifications).toBe(0)
    expect(scheduled).not.toBeNull()
    ;(scheduled as unknown as () => void)()
    expect(notifications).toBe(1)
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks[0].content).toBe("one two three")

    // A structural event must flush pending text synchronously first, so
    // `done` commits every preceding byte instead of finalising early.
    callbacks.onEvent("message", { agent: "lead", text: " done" })
    callbacks.onEvent("done", {})
    expect(scheduled).toBeNull()
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
    expect(useAgentStore.getState().agentStreams.lead.blocks[0].content).toBe("one two three done")
    expect(notifications).toBe(3) // one delta flush + one delta flush + done
    unsubscribe()
  })

  it("sets isConnected=true", () => {
    useAgentStore.setState({ sessionId: "stream-sid" })
    useAgentStore.getState().connectStream()
    expect(useAgentStore.getState().isConnected).toBe(true)
  })

  it("returns an AbortController", () => {
    useAgentStore.setState({ sessionId: "stream-sid" })
    const abort = useAgentStore.getState().connectStream()
    expect(abort).toBeInstanceOf(AbortController)
  })

  it("returns a new AbortController when sessionId is null (no-op)", () => {
    useAgentStore.setState({ sessionId: null })
    const abort = useAgentStore.getState().connectStream()
    expect(abort).toBeInstanceOf(AbortController)
    expect(mockTeamStream).not.toHaveBeenCalled()
  })

  it("aborts previous stream before opening a new one", () => {
    const fakeAbort = new AbortController()
    const abortSpy = spyOn(fakeAbort, "abort")
    useAgentStore.setState({ sessionId: "stream-sid", _abortController: fakeAbort })
    useAgentStore.getState().connectStream()
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  it("passes an AbortSignal to agentStream", () => {
    useAgentStore.setState({ sessionId: "stream-sid" })
    useAgentStore.getState().connectStream()
    const signal = mockTeamStream.mock.calls[0][2]
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it("onError sets error and isConnected=false for non-transport failures", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new Error("SSE parser failed"))
    expect(useAgentStore.getState().error).toBe("SSE parser failed")
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("downgrades iOS transport stream failures while work continues", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isConnected).toBe(false)
    expect(useAgentStore.getState().isAgentWorking).toBe(true)
  })

  it("schedules a reconnect after a transient network error while working", () => {
    // Capture the setTimeout callback so we can fire it synchronously.
    let timerCb!: () => void
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    // First call captures callbacks; second call (reconnect) just sets isConnected.
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Timer scheduled, stream not yet reconnected.
    expect(timerCb).toBeDefined()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

    // Fire the timer — should reopen the stream.
    timerCb()
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().isConnected).toBe(true)

  })

  it("backs off repeated transient reconnects and resets after an event", () => {
    const delays: number[] = []
    const callbacks: Array<() => void> = []
    spyOn(globalThis, "setTimeout").mockImplementation((...args: unknown[]) => {
      const [cb, delay] = args as [() => void, number | undefined]
      callbacks.push(cb)
      delays.push(delay ?? 0)
      return callbacks.length as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let streamCallbacks!: { onError: (err: Error) => void; onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof streamCallbacks) => { streamCallbacks = cbs })

    useAgentStore.getState().connectStream()
    streamCallbacks.onError(new TypeError("Load failed"))
    expect(delays[0]).toBe(1_500)
    callbacks.shift()?.()

    streamCallbacks.onError(new TypeError("Load failed"))
    expect(delays[1]).toBe(3_000)
    streamCallbacks.onEvent("message", { text: "recovered", agent: "lead" })
    expect(useAgentStore.getState()._reconnectAttempts).toBe(0)
  })

  it("clears a pending reconnect timer when starting a new session", () => {
    let timerCb!: () => void
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout")
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 123 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    expect(useAgentStore.getState()._reconnectTimer).toBe(123)

    useAgentStore.getState().newSession()

    expect(clearTimeoutSpy).toHaveBeenCalledWith(123)
    expect(useAgentStore.getState()._reconnectTimer).toBeNull()

    // Even if the old callback somehow runs, teardown should still prevent reconnect.
    timerCb()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("does not reconnect from the timer if the session changed", () => {
    let timerCb!: () => void
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Navigate away — bumps generation.
    useAgentStore.getState().newSession()

    // Timer fires but the generation guard should prevent reconnect.
    timerCb()
    // agentStream called only once (the original connect), not again.
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("does not reconnect from the timer if already reconnected", () => {
    let timerCb!: () => void
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Manually reconnect before the timer fires (e.g. visibilitychange).
    useAgentStore.setState({ isConnected: true })

    timerCb()
    // Still only one agentStream call — isConnected guard prevents the extra one.
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("ignores stream errors while the page is unloading", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true, _unloading: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new Error("NetworkError when attempting to fetch resource"))
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isConnected).toBe(true)
  })

  it("ignores backend error events while the page is unloading", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true, _unloading: true })
    let callbacks!: { onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onEvent("error", { message: "Error in input stream" })
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isAgentWorking).toBe(true)
  })

  it("onDone sets isConnected=false and patches the session running flag", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid" })
    useAgentStore.getState().connectStream()

    expect(useAgentStore.getState().isConnected).toBe(false)
    // Patched in place rather than invalidating the (infinite, sequentially
    // refetched) session list just to clear a running badge.
    expect(useAgentStore.getState().cacheInvalidations).toContainEqual({
      kind: "session_running",
      sessionId: "stream-sid",
      running: false,
    })
  })

  it("onDone reopens the stream immediately when the session is still working", () => {
    // Simulates an idle-keepalive close mid-run: the backend cleanly closes a
    // channel that had been delivering events, while isAgentWorking is true.
    let callCount = 0
    mockTeamStream.mockImplementation(
      (
        _sid: string,
        cbs: {
          onDone?: () => void
          onEvent?: (type: string, data: unknown) => void
        },
      ) => {
        callCount++
        // Only fire onDone on the first call to avoid an infinite loop in the test.
        if (callCount === 1) {
          cbs.onEvent?.("agent_status", { agent: "lead", status: "working" })
          cbs.onDone?.()
        }
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })
    useAgentStore.getState().connectStream()

    // Should have opened the stream twice: original + reconnect.
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().isConnected).toBe(true)
    // No cache invalidation pushed. The session is still in-flight.
  })

  it("backs off instead of reopening when the stream closed having delivered nothing", () => {
    // A backend holding no turn state for this session returns from `attach`
    // straight away. That is a *clean* close, so it raises no error to reach
    // the backoff in onError — and reopening at once turns a suspended
    // question into a request storm for as long as the card is unanswered.
    let callCount = 0
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        callCount++
        if (callCount === 1) cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })
    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState()._reconnectAttempts).toBe(1)
    expect(useAgentStore.getState()._reconnectTimer).not.toBeNull()

    clearTimeout(useAgentStore.getState()._reconnectTimer as ReturnType<typeof setTimeout>)
    useAgentStore.setState({ _reconnectTimer: null, _reconnectAttempts: 0 })
  })

  it("does not reopen a second time when a superseded connection's onDone fires after its own abort", () => {
    // Reproduces "duplicate messages during streaming, fixed only by reload":
    // connection A's underlying `reader.read()` can resolve with `done: true`
    // (server closed the body) in the same tick that something else (e.g. the
    // tab regaining focus) already called `connectStream()` again and aborted
    // A in favor of a fresh connection B. `onError` already guards against
    // this via `abort.signal.aborted`; `onDone` must too, or A's belated
    // "reopen" spawns a second live connection racing B — both then apply
    // every subsequent SSE event, doubling everything until a reload.
    const callbacksByCall: Array<{ onDone?: () => void }> = []
    mockTeamStream.mockImplementation((_sid: string, cbs: { onDone?: () => void }) => {
      callbacksByCall.push(cbs)
    })
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })

    useAgentStore.getState().connectStream() // connection A
    const onDoneA = callbacksByCall[0].onDone!
    useAgentStore.getState().connectStream() // something else reconnects — aborts A, opens B
    expect(mockTeamStream).toHaveBeenCalledTimes(2)

    onDoneA() // A's belated, already-superseded "done" fires

    // Must still be exactly 2 (A, B) — not 3. A is aborted and must not reopen.
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
  })

  it("onDone does not reopen the stream when the page is unloading", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true, _unloading: true })
    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("does not reconnect after onDone when queued messages are pending", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({
      sessionId: "stream-sid",
      _pendingMessages: [{ id: "pm-1", sessionId: "stream-sid", content: "queued" }],
    })

    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("does not reconnect after onDone when no queued messages are pending", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid" })

    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("ignores a stray event delivered by a superseded connection within the same session", () => {
    // Narrower cousin of the onDone race above: connection A's `reader.read()`
    // can have *already resolved* with a chunk the instant before something
    // else reconnects (abort A, open B) for the *same* session — no session
    // or generation change, so that guard alone cannot catch it. B's own
    // attach/replay independently delivers the same content correctly, so
    // dropping A's stray leftover is safe and prevents double-applying it.
    const callbacksByCall: Array<{ onEvent: (type: string, data: unknown) => void }> = []
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onEvent: (type: string, data: unknown) => void }) => {
        callbacksByCall.push(cbs)
      }
    )
    useAgentStore.setState({
      sessionId: "session-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    useAgentStore.getState().connectStream() // connection A
    const onEventA = callbacksByCall[0].onEvent
    useAgentStore.getState().connectStream() // reconnect — aborts A, opens B (same session)

    // tool_call (unlike message/thinking) applies synchronously with no
    // coalescing timer, so this is observable without advancing fake timers.
    onEventA("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc-a" })

    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
  })

  it("stops counting as connected when its live stream is aborted from outside", () => {
    // Something other than a reconnect (a component cleanup, a send that
    // tears the old stream down first) aborted the live stream. Left at
    // `isConnected: true`, every recovery path ("already connected and
    // working") skipped this session, and the chat stayed frozen until a
    // reload.
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    const abort = useAgentStore.getState().connectStream()
    abort.abort()
    expect(useAgentStore.getState().isConnected).toBe(false)
    expect(useAgentStore.getState()._abortController).toBeNull()
  })

  it("stays connected when a reconnect replaces the stream", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    useAgentStore.getState().connectStream()
    const second = useAgentStore.getState().connectStream()
    expect(useAgentStore.getState().isConnected).toBe(true)
    expect(useAgentStore.getState()._abortController).toBe(second)
  })

  it("ignores stream events after newSession changes generation", () => {
    let onEvent!: (type: string, data: unknown) => void
    let onDone!: () => void
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onEvent: (type: string, data: unknown) => void; onDone?: () => void }) => {
        onEvent = cbs.onEvent
        onDone = cbs.onDone ?? (() => {})
      }
    )
    useAgentStore.setState({
      sessionId: "session-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    useAgentStore.getState().connectStream()
    useAgentStore.getState().newSession()
    onEvent("message", { agent: "lead", text: "stale token" })
    onDone()

    const state = useAgentStore.getState()
    expect(state.sessionId).toBeNull()
    expect(state.isAgentWorking).toBe(false)
    expect(state.agentStreams.lead.currentBlocks).toHaveLength(0)
  })
})
