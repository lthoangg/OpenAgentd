import { describe, it, expect, beforeEach } from "bun:test"
import { useTeamStore } from "@/stores/useTeamStore"

/**
 * ``ask_user_question`` store behaviour.
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
  useTeamStore.setState({
    agentStreams: {},
    activeAgent: null,
    leadName: "openagentd",
    agentNames: ["openagentd"],
    liveAgentNames: null,
    sessionId: SESSION_ID,
    isTeamWorking: false,
    isConnected: true,
    pendingQuestion: null,
    resolvedQuestions: {},
    cacheInvalidations: [],
  } as never)
}

function ask(overrides: Record<string, unknown> = {}) {
  useTeamStore.getState()._handleSSEEvent("question_asked", {
    question_id: QUESTION_ID,
    session_id: SESSION_ID,
    tool_call_id: "call-1",
    questions: QUESTIONS,
    ...overrides,
  })
}

describe("useTeamStore — ask_user_question", () => {
  beforeEach(resetStore)

  it("stores the question payload on question_asked", () => {
    ask()

    const pending = useTeamStore.getState().pendingQuestion
    expect(pending).not.toBeNull()
    expect(pending!.id).toBe(QUESTION_ID)
    expect(pending!.toolCallId).toBe("call-1")
    expect(pending!.questions[0].header).toBe("Package manager")
    expect(pending!.questions[0].options[0].recommended).toBe(true)
  })

  it("marks the lead as waiting_input and keeps the team live", () => {
    useTeamStore.getState()._handleSSEEvent("agent_status", {
      agent: "openagentd",
      status: "waiting_input",
      metadata: { question_id: QUESTION_ID },
    })

    const state = useTeamStore.getState()
    expect(state.agentStreams.openagentd.status).toBe("waiting_input")
    expect(state.isTeamWorking).toBe(true)
  })

  it("clears the question when it is answered elsewhere", () => {
    ask()

    useTeamStore.getState()._handleSSEEvent("question_answered", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      answers: [["pnpm"]],
    })

    expect(useTeamStore.getState().pendingQuestion).toBeNull()
  })

  it("records the outcome against the tool call so the card can resolve at once", () => {
    ask()

    useTeamStore.getState()._handleSSEEvent("question_answered", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      answers: [["pnpm"]],
    })

    // The persisted tool result still says "waiting" until the turn ends and
    // history reconciles, so the transcript card reads this instead.
    const resolved = useTeamStore.getState().resolvedQuestions["call-1"]
    expect(resolved.answers).toEqual([["pnpm"]])
    expect(resolved.questions[0].header).toBe("Package manager")
  })

  it("records a dismissal with no answers", () => {
    ask()

    useTeamStore.getState()._handleSSEEvent("question_dismissed", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      reason: "dismissed",
    })

    expect(useTeamStore.getState().resolvedQuestions["call-1"].answers).toBeNull()
  })

  it("clears the question when it is dismissed", () => {
    ask()

    useTeamStore.getState()._handleSSEEvent("question_dismissed", {
      question_id: QUESTION_ID,
      session_id: SESSION_ID,
      reason: "superseded",
    })

    expect(useTeamStore.getState().pendingQuestion).toBeNull()
  })

  it("ignores a resolution for a question it is not showing", () => {
    ask()

    useTeamStore.getState()._handleSSEEvent("question_answered", {
      question_id: "018f0000-0000-7000-8000-0000000000cc",
      session_id: SESSION_ID,
      answers: [["bun"]],
    })

    expect(useTeamStore.getState().pendingQuestion?.id).toBe(QUESTION_ID)
  })

  it("replaces an earlier question rather than stacking cards", () => {
    ask()
    ask({ question_id: "018f0000-0000-7000-8000-0000000000dd", tool_call_id: "call-2" })

    const pending = useTeamStore.getState().pendingQuestion
    expect(pending!.id).toBe("018f0000-0000-7000-8000-0000000000dd")
  })

  it("drops the question when the turn is reset for a new one", () => {
    ask()

    useTeamStore.getState()._handleSSEEvent("session", { session_id: SESSION_ID })

    expect(useTeamStore.getState().pendingQuestion).toBeNull()
  })
})
