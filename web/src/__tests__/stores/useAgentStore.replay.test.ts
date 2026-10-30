/**
 * Streamed-text accumulation vs. attach replay snapshots.
 *
 * `memory_stream_store.attach` replays the whole accumulated turn text as a
 * single `thinking` / `message` event (at most one of each per agent) before
 * forwarding live events. That snapshot must *replace* what the client already
 * rendered, or a reconnect doubles the visible text.
 *
 * But a prefix match on its own is ambiguous — genuine deltas repeat their
 * prefix all the time (`"-"` then `"-"`). Deciding "replay?" from content
 * alone therefore silently dropped real tokens mid-stream. The signal is now
 * explicit: only the first chunk of each kind after an attach may be treated
 * as a snapshot.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test"
import { useAgentStore } from "@/stores/useAgentStore"

const realLoadSession = useAgentStore.getState().loadSession
afterAll(() => useAgentStore.setState({ loadSession: realLoadSession }))

beforeEach(() => {
  useAgentStore.setState({
    loadSession: mock(async () => {}),
    _pendingMessages: [],
    _attachReplay: false,
    agentStreams: {},
    agentNames: [],
    leadName: "lead",
    sessionId: "s1",
    isAgentWorking: false,
    isConnected: false,
    cacheInvalidations: [],
  })
})

function emit(type: string, data: Record<string, unknown>) {
  useAgentStore.getState()._handleSSEEvent(type, data)
}

function textOf(agent = "lead"): string {
  const blocks = useAgentStore.getState().agentStreams[agent]?.currentBlocks ?? []
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.content)
    .join("")
}

function thinkingOf(agent = "lead"): string {
  const blocks = useAgentStore.getState().agentStreams[agent]?.currentBlocks ?? []
  return blocks
    .filter((b) => b.type === "thinking")
    .map((b) => b.content)
    .join("")
}

/** Arm the replay guard exactly the way `connectStream` does on attach. */
function simulateAttach() {
  useAgentStore.setState((state) => ({
    _attachReplay: true,
    agentStreams: Object.fromEntries(
      Object.entries(state.agentStreams).map(([name, stream]) => [
        name,
        { ...stream, _replayPending: { message: true, thinking: true } },
      ]),
    ),
  }))
}

describe("streamed text accumulation", () => {
  it("concatenates ordinary deltas", () => {
    emit("message", { agent: "lead", text: "Hello" })
    emit("message", { agent: "lead", text: " world" })
    expect(textOf()).toBe("Hello world")
  })

  it("does not drop a delta that repeats the accumulated text", () => {
    // Regression: `---` streamed as three single-dash deltas used to render
    // as `-` because each delta looked like a replay snapshot of the previous.
    emit("message", { agent: "lead", text: "-" })
    emit("message", { agent: "lead", text: "-" })
    emit("message", { agent: "lead", text: "-" })
    expect(textOf()).toBe("---")
  })

  it("does not drop repeated bold markers", () => {
    emit("message", { agent: "lead", text: "*" })
    emit("message", { agent: "lead", text: "*" })
    emit("message", { agent: "lead", text: "bold" })
    emit("message", { agent: "lead", text: "**" })
    expect(textOf()).toBe("**bold**")
  })

  it("does not drop a repeated newline (paragraph break)", () => {
    emit("message", { agent: "lead", text: "a" })
    emit("message", { agent: "lead", text: "\n" })
    emit("message", { agent: "lead", text: "\n" })
    emit("message", { agent: "lead", text: "b" })
    expect(textOf()).toBe("a\n\nb")
  })

  it("keeps the same guarantee for thinking deltas", () => {
    emit("thinking", { agent: "lead", text: "-" })
    emit("thinking", { agent: "lead", text: "-" })
    expect(thinkingOf()).toBe("--")
  })
})

describe("attach replay snapshots", () => {
  it("replaces rather than doubles the accumulated text after an attach", () => {
    emit("message", { agent: "lead", text: "The answer is" })
    simulateAttach()
    emit("message", { agent: "lead", text: "The answer is 42." })
    expect(textOf()).toBe("The answer is 42.")
  })

  it("replaces on an exact-equal snapshot (reconnect with no new tokens)", () => {
    emit("message", { agent: "lead", text: "Hello there" })
    simulateAttach()
    emit("message", { agent: "lead", text: "Hello there" })
    expect(textOf()).toBe("Hello there")
  })

  it("treats only the FIRST chunk after an attach as a snapshot", () => {
    emit("message", { agent: "lead", text: "Hi" })
    simulateAttach()
    emit("message", { agent: "lead", text: "Hi there" }) // snapshot -> replace
    emit("message", { agent: "lead", text: "Hi there" }) // live delta -> append
    expect(textOf()).toBe("Hi thereHi there")
  })

  it("tracks message and thinking snapshots independently", () => {
    emit("thinking", { agent: "lead", text: "Let me check" })
    emit("message", { agent: "lead", text: "Result:" })
    simulateAttach()
    // Backend replays thinking first, then content.
    emit("thinking", { agent: "lead", text: "Let me check the docs" })
    emit("message", { agent: "lead", text: "Result: 42" })
    expect(thinkingOf()).toBe("Let me check the docs")
    expect(textOf()).toBe("Result: 42")
  })

  it("does not duplicate a thinking+text turn on reconnect", () => {
    // The turn's last block is `text`, so the replayed *thinking* snapshot
    // finds a type mismatch at the tail. It must rewrite the earlier thinking
    // block rather than append a second copy of the turn.
    emit("thinking", { agent: "lead", text: "reasoning" })
    emit("message", { agent: "lead", text: "answer" })
    simulateAttach()
    emit("thinking", { agent: "lead", text: "reasoning" })
    emit("message", { agent: "lead", text: "answer" })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.filter((b) => b.type === "thinking")).toHaveLength(1)
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(1)
    expect(thinkingOf()).toBe("reasoning")
    expect(textOf()).toBe("answer")
  })

  it("still opens a new thinking block when live reasoning follows text", () => {
    // No attach pending: the model legitimately went back to reasoning after
    // emitting text, so this must NOT be folded into the earlier block.
    emit("thinking", { agent: "lead", text: "first" })
    emit("message", { agent: "lead", text: "answer" })
    emit("thinking", { agent: "lead", text: "second" })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.filter((b) => b.type === "thinking")).toHaveLength(2)
    expect(thinkingOf()).toBe("firstsecond")
  })

  it("does not merge a replay snapshot across a turn boundary", () => {
    // A user block ends the turn the snapshot describes.
    emit("thinking", { agent: "lead", text: "old turn reasoning" })
    useAgentStore.setState((s) => {
      s.agentStreams.lead.currentBlocks.push({ id: "user-1", type: "user", content: "next question" })
    })
    simulateAttach()
    emit("thinking", { agent: "lead", text: "old turn reasoning" })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.filter((b) => b.type === "thinking")).toHaveLength(2)
  })

  it("arms the guard per agent, not globally", () => {
    emit("message", { agent: "lead", text: "A" })
    emit("message", { agent: "worker", text: "B" })
    simulateAttach()
    emit("message", { agent: "lead", text: "A!" })
    // `worker`'s guard is still armed — its own snapshot has not arrived yet.
    emit("message", { agent: "worker", text: "B!" })
    expect(textOf("lead")).toBe("A!")
    expect(textOf("worker")).toBe("B!")
  })

  it("re-arms on a second attach", () => {
    emit("message", { agent: "lead", text: "one" })
    simulateAttach()
    emit("message", { agent: "lead", text: "one two" })
    simulateAttach()
    emit("message", { agent: "lead", text: "one two three" })
    expect(textOf()).toBe("one two three")
  })

  it("does not corrupt a fresh stream created during a replay", () => {
    // Agent seen for the first time in the replay phase: its accumulated
    // content is empty, so replace and append are equivalent.
    emit("message", { agent: "newcomer", text: "partial output" })
    expect(textOf("newcomer")).toBe("partial output")
  })

/** Every block the transcript shows for an agent: confirmed rows, then live. */
function shown(agent = "lead") {
  const stream = useAgentStore.getState().agentStreams[agent]
  return [...(stream?.blocks ?? []), ...(stream?.currentBlocks ?? [])]
}

/** The frames `attach` replays for a turn that injected a queued message. */
function replayQueuedStep() {
  emit("agent_status", { agent: "lead", status: "working" })
  emit("queued_turn_start", {
    agent: "lead",
    message_ids: ["msg-steer"],
    messages: [{ id: "msg-steer", content: "also say OK" }],
  })
  emit("message", { agent: "lead", text: "Noted, I will say OK." })
  emit("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-2" })
  emit("tool_start", { agent: "lead", name: "shell", tool_call_id: "tc-2", arguments: '{"command":"echo two"}' })
}

describe("attach replay of an injected queued message", () => {
  it("shows the steer and the step after it once when the stream reattaches", () => {
    emit("message", { agent: "lead", text: "Running the first command." })
    emit("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-1" })
    emit("tool_end", { agent: "lead", name: "shell", tool_call_id: "tc-1", result: "one" })
    replayQueuedStep()

    simulateAttach()
    replayQueuedStep()

    const blocks = shown()
    expect(blocks.filter((b) => b.id === "msg-steer")).toHaveLength(1)
    expect(blocks.filter((b) => b.type === "text" && b.content === "Noted, I will say OK.")).toHaveLength(1)
    expect(blocks.filter((b) => b.toolCallId === "tc-2")).toHaveLength(1)
    // The steer still sits before the reply it started.
    const order = blocks.map((b) => b.id)
    const replyIndex = blocks.findIndex((b) => b.content === "Noted, I will say OK.")
    expect(order.indexOf("msg-steer")).toBeLessThan(replyIndex)
  })

  it("does not double the step when the steer is already a confirmed history row", () => {
    // A resume reloaded history first: the steer is confirmed, the step after
    // it is still the live tail.
    useAgentStore.setState((s) => {
      s.agentStreams.lead = {
        ...(s.agentStreams.lead ?? {}),
        blocks: [{ id: "msg-steer", type: "user", content: "also say OK" }],
        currentBlocks: [
          { id: "live-text", type: "text", content: "Noted, I will say OK." },
          { id: "tc-2", type: "tool", toolName: "shell", toolCallId: "tc-2", toolArgs: '{"command":"echo two"}' },
        ],
        currentText: "",
        currentThinking: "",
        status: "working",
        lastError: null,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
      } as never
    })

    simulateAttach()
    replayQueuedStep()

    const blocks = shown()
    expect(blocks.filter((b) => b.id === "msg-steer")).toHaveLength(1)
    expect(blocks.filter((b) => b.type === "text" && b.content === "Noted, I will say OK.")).toHaveLength(1)
    expect(blocks.filter((b) => b.toolCallId === "tc-2")).toHaveLength(1)
  })

  it("still starts a new turn for a steer the client has not shown yet", () => {
    emit("message", { agent: "lead", text: "Working on it." })
    simulateAttach()
    emit("queued_turn_start", {
      agent: "lead",
      message_ids: ["msg-new"],
      messages: [{ id: "msg-new", content: "one more thing" }],
    })

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.content)).toEqual(["Working on it."])
    expect(stream.currentBlocks.map((b) => b.id)).toEqual(["msg-new"])
  })

  it("reloads history when a replay starts at a steer the loaded page has not reached", () => {
    // The page was read just before the rows ahead of this steer were saved,
    // and the replay only starts at the steer: those rows are on no screen.
    const loadSession = mock(async () => {})
    useAgentStore.setState({ loadSession, _workspace: "/repo" })
    emit("message", { agent: "lead", text: "Working on it." })
    simulateAttach()
    replayQueuedStep()

    expect(loadSession).toHaveBeenCalledTimes(1)
    expect(loadSession).toHaveBeenCalledWith("s1", "/repo")
  })

  it("does not reload history for a live steer", () => {
    const loadSession = mock(async () => {})
    useAgentStore.setState({ loadSession, _workspace: "/repo" })
    emit("message", { agent: "lead", text: "Working on it." })
    replayQueuedStep()

    expect(loadSession).not.toHaveBeenCalled()
  })
})

  it("retains single tool call block on reconnect replay", () => {
    emit("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-100" })
    emit("tool_start", { agent: "lead", name: "shell", tool_call_id: "tc-100", arguments: '{"command":"ls"}' })
    simulateAttach()
    emit("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-100" })
    emit("tool_start", { agent: "lead", name: "shell", tool_call_id: "tc-100", arguments: '{"command":"ls"}' })
    emit("tool_end", { agent: "lead", name: "shell", tool_call_id: "tc-100", result: "file.txt" })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    const toolBlocks = blocks.filter((b) => b.type === "tool")
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0].toolCallId).toBe("tc-100")
    expect(toolBlocks[0].toolDone).toBe(true)
    expect(toolBlocks[0].toolResult).toBe("file.txt")
  })

  it("keeps ask_user open across a stream reconnect mid-wait", () => {
    emit("tool_call", { agent: "lead", name: "ask_user", tool_call_id: "tc-ask-1" })
    emit("question_asked", {
      question_id: "q-1",
      session_id: "s1",
      tool_call_id: "tc-ask-1",
      questions: [{ question: "Proceed?", header: "Confirmation", multiple: false, custom: true, options: [] }],
    })
    emit("agent_status", { agent: "lead", status: "waiting_input" })

    simulateAttach()
    emit("agent_status", { agent: "lead", status: "waiting_input" })

    const state = useAgentStore.getState()
    expect(state.pendingQuestion?.id).toBe("q-1")
    expect(state.agentStreams.lead.status).toBe("waiting_input")
    expect(state.isAgentWorking).toBe(true)
  })

  it("updates ask_user to resolved on reconnect when question was resolved elsewhere", () => {
    emit("tool_call", { agent: "lead", name: "ask_user", tool_call_id: "tc-ask-2" })
    emit("question_asked", {
      question_id: "q-2",
      session_id: "s1",
      tool_call_id: "tc-ask-2",
      questions: [{ question: "Deploy?", header: "Deploy", multiple: false, custom: true, options: [] }],
    })

    simulateAttach()
    emit("question_answered", { question_id: "q-2", answers: [["Yes"]] })

    const state = useAgentStore.getState()
    expect(state.pendingQuestion).toBeNull()
    expect(state.resolvedQuestions["tc-ask-2"]?.answers).toEqual([["Yes"]])
  })
})
