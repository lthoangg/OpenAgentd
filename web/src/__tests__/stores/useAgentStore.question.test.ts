import { describe, it, expect, beforeEach, mock } from "bun:test"
import { useAgentStore, isAwaitingRestartOutput } from "@/stores/useAgentStore"

/**
 * ``ask_user`` store behaviour.
 *
 * A suspended lead is neither working nor idle, and the question that suspended
 * it is durable server-side. The store therefore has to:
 *
 * - hold the question so the dock can render it (and re-render it from the SSE
 *   replay buffer after a mid-wait reload),
 * - keep the session marked live while waiting, so the UI does not look
 *   finished with a question still on screen,
 * - drop the question when *any* client answers or dismisses it, since the
 *   same session can be open on two devices.
 */

const QUESTION_ID = "018f0000-0000-7000-8000-0000000000aa"
const SESSION_ID = "018f0000-0000-7000-8000-0000000000bb"

const QUESTIONS = [
  {
    question: "Which package manager?",
    header: "Package manager",
    multiple: false,
    custom: true,
    options: [
      { label: "pnpm", description: "Fast", recommended: true },
      { label: "bun", description: "Faster", recommended: false },
    ],
  },
]

function resetStore() {
  useAgentStore.setState({
    agentStreams: {},
    leadName: "openagentd",
    agentNames: ["openagentd"],
    liveAgentNames: null,
    sessionId: SESSION_ID,
    isAgentWorking: false,
    isConnected: true,
    pendingQuestion: null,
    resolvedQuestions: {},
    cacheInvalidations: [],
    connectStream: () => new AbortController(),
  } as never)
}

function ask(overrides: Record<string, unknown> = {}) {
  useAgentStore.getState()._handleSSEEvent("question_asked", {
    question_id: QUESTION_ID,
    session_id: SESSION_ID,
    tool_call_id: "call-1",
    questions: QUESTIONS,
    ...overrides,
  })
}

describe("useAgentStore — ask_user", () => {
  beforeEach(resetStore)

  it("stores the question payload on question_asked", () => {
    ask()

    const pending = useAgentStore.getState().pendingQuestion
    expect(pending).not.toBeNull()
    expect(pending!.id).toBe(QUESTION_ID)
    expect(pending!.toolCallId).toBe("call-1")
    expect(pending!.questions[0].header).toBe("Package manager")
    expect(pending!.questions[0].options[0].recommended).toBe(true)
  })

  it("marks the lead as waiting_input and keeps the team live", () => {
    useAgentStore.getState()._handleSSEEvent("agent_status", {
      agent: "openagentd",
      status: "waiting_input",
      metadata: { question_id: QUESTION_ID },
    })

    const state = useAgentStore.getState()
    expect(state.agentStreams.openagentd.status).toBe("waiting_input")
    expect(state.isAgentWorking).toBe(true)
  })

  it("clears the question when it is answered elsewhere", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("question_answered", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      answers: [["pnpm"]],
    })

    expect(useAgentStore.getState().pendingQuestion).toBeNull()
  })

  it("records the outcome against the tool call so the card can resolve at once", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("question_answered", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      answers: [["pnpm"]],
    })

    // The persisted tool result still says "waiting" until the turn ends and
    // history reconciles, so the transcript card reads this instead.
    const resolved = useAgentStore.getState().resolvedQuestions["call-1"]
    expect(resolved.answers).toEqual([["pnpm"]])
    expect(resolved.questions[0].header).toBe("Package manager")
  })

  it("records a dismissal with no answers", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("question_dismissed", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      reason: "dismissed",
    })

    expect(useAgentStore.getState().resolvedQuestions["call-1"].answers).toBeNull()
  })

  it("records why a question ended without an answer", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("question_dismissed", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      reason: "superseded",
    })

    // "Dismissed" and "superseded" are different stories to tell the user, and
    // the card cannot tell them apart from a null answer list alone.
    const resolved = useAgentStore.getState().resolvedQuestions["call-1"]
    expect(resolved.reason).toBe("superseded")
    expect(resolved.questions[0].header).toBe("Package manager")
  })

  it("keeps the reason null when the question was answered", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("question_answered", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      answers: [["pnpm"]],
    })

    expect(useAgentStore.getState().resolvedQuestions["call-1"].reason).toBeNull()
  })

  it("clears the question when it is dismissed", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("question_dismissed", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      reason: "superseded",
    })

    expect(useAgentStore.getState().pendingQuestion).toBeNull()
  })

  it("records a supersede when a new turn starts over an open question", () => {
    ask()

    // Typing instead of answering starts a fresh turn; the server has already
    // closed the question, and the card must say so rather than fall back to
    // "waiting" for an answer that can never arrive.
    useAgentStore.getState()._handleSSEEvent("session", { session_id: SESSION_ID })

    const state = useAgentStore.getState()
    expect(state.pendingQuestion).toBeNull()
    expect(state.resolvedQuestions["call-1"].reason).toBe("superseded")
    expect(state.resolvedQuestions["call-1"].answers).toBeNull()
  })

  it("keeps an open question when a done event arrives", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("done", { session_id: SESSION_ID })

    // `done` says the turn stopped running, not that the question is void: the
    // row stays `pending` in the database and a reload brings the card back
    // fully answerable. Closing it here would show "No longer relevant" for a
    // question the server is still waiting on.
    const state = useAgentStore.getState()
    expect(state.pendingQuestion?.id).toBe(QUESTION_ID)
    expect(state.resolvedQuestions["call-1"]).toBeUndefined()
  })

  it("ignores a resolution for a question it is not showing", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("question_answered", {
      question_id: "018f0000-0000-7000-8000-0000000000cc",
      session_id: SESSION_ID,
      answers: [["bun"]],
    })

    expect(useAgentStore.getState().pendingQuestion?.id).toBe(QUESTION_ID)
  })

  it("replaces an earlier question rather than stacking cards", () => {
    ask()
    ask({ question_id: "018f0000-0000-7000-8000-0000000000dd", tool_call_id: "call-2" })

    const pending = useAgentStore.getState().pendingQuestion
    expect(pending!.id).toBe("018f0000-0000-7000-8000-0000000000dd")
  })

  describe("resuming after an answer", () => {
    /**
     * Read the dots decision the way the components do.
     *
     * Asserted through the selector rather than a stored flag on purpose: the
     * cases below are the exit paths a restarted turn can take, and the point
     * of deriving the answer is that none of them needs its own bookkeeping.
     */
    function awaitingRestart(): boolean {
      return isAwaitingRestartOutput(useAgentStore.getState().agentStreams.openagentd)
    }

    function suspend() {
      useAgentStore.getState()._handleSSEEvent("agent_status", {
        agent: "openagentd",
        status: "waiting_input",
        metadata: { question_id: QUESTION_ID },
      })
    }

    it("marks the lead live again so the turn does not look finished", () => {
      // The resumed run carries no new user message, so nothing else flips the
      // lead back to working until its first token — which can be seconds away.
      suspend()

      useAgentStore.getState().markTurnResuming()

      const stream = useAgentStore.getState().agentStreams.openagentd
      expect(stream.status).toBe("working")
      expect(awaitingRestart()).toBe(true)
      expect(useAgentStore.getState().isAgentWorking).toBe(true)
    })

    it("stops awaiting the restart once the turn produces text", () => {
      suspend()
      useAgentStore.getState().markTurnResuming()

      useAgentStore.getState()._handleSSEEvent("message", {
        agent: "openagentd",
        content: "Using pnpm.",
      })

      expect(awaitingRestart()).toBe(false)
    })

    it("stops awaiting the restart once the turn calls a tool", () => {
      suspend()
      useAgentStore.getState().markTurnResuming()

      useAgentStore.getState()._handleSSEEvent("tool_call", {
        agent: "openagentd",
        name: "shell",
        tool_call_id: "call-2",
      })

      expect(awaitingRestart()).toBe(false)
    })

    it("stops awaiting the restart when the agent reports it went idle", () => {
      // After a daemon restart the reconnecting client can miss the resumed
      // turn's deltas and its `done` entirely; the status snapshot is then the
      // only signal left that the turn is over.
      suspend()
      useAgentStore.getState().markTurnResuming()

      useAgentStore.getState()._handleSSEEvent("agent_status", {
        agent: "openagentd",
        status: "idle",
      })

      expect(awaitingRestart()).toBe(false)
    })

    it("stops awaiting the restart when the resumed turn parks on another question", () => {
      suspend()
      useAgentStore.getState().markTurnResuming()

      useAgentStore.getState()._handleSSEEvent("agent_status", {
        agent: "openagentd",
        status: "waiting_input",
      })

      expect(awaitingRestart()).toBe(false)
    })

    it("keeps awaiting the restart while the agent is only reported working", () => {
      // `working` with nothing produced yet is precisely when the dots belong.
      suspend()
      useAgentStore.getState().markTurnResuming()

      useAgentStore.getState()._handleSSEEvent("agent_status", {
        agent: "openagentd",
        status: "working",
      })

      expect(awaitingRestart()).toBe(true)
    })

    it("stops awaiting the restart when the turn ends without output", () => {
      // Backstop: a resume that dies before emitting anything must not leave
      // the dots bouncing forever.
      suspend()
      useAgentStore.getState().markTurnResuming()

      useAgentStore.getState()._handleSSEEvent("done", { session_id: SESSION_ID })

      expect(awaitingRestart()).toBe(false)
    })

    it("does not strand the flag on the next session opened", () => {
      suspend()
      useAgentStore.getState().markTurnResuming()

      useAgentStore.getState().beginResolvedSession(null, { workspace: "/repo/app" })

      expect(awaitingRestart()).toBe(false)
    })

    /**
     * The resumed turn streams into the session's SSE channel. A parked turn
     * normally keeps that channel open, but a network blip while waiting
     * leaves the client on a backoff timer — up to 30s — and the resumed
     * output would sit unseen until it fires. Reattach at once instead.
     */
    it("reopens the stream when the answer lands while disconnected", () => {
      const connectStream = mock(() => new AbortController())
      useAgentStore.setState({ isConnected: false, connectStream } as never)
      suspend()

      useAgentStore.getState().markTurnResuming()

      expect(connectStream).toHaveBeenCalledTimes(1)
    })

    it("replaces even a nominally connected stream when the answer lands", () => {
      const connectStream = mock(() => new AbortController())
      useAgentStore.setState({ isConnected: true, connectStream } as never)
      suspend()

      useAgentStore.getState().markTurnResuming()

      expect(connectStream).toHaveBeenCalledTimes(1)
    })
  })

  it("drops the question when the turn is reset for a new one", () => {
    ask()

    useAgentStore.getState()._handleSSEEvent("session", { session_id: SESSION_ID })

    expect(useAgentStore.getState().pendingQuestion).toBeNull()
  })
})
