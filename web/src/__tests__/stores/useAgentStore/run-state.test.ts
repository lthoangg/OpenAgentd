/**
 * The session run machine (``stores/useAgentStore/run-state.ts``): its table,
 * the moves it refuses, the snapshot verdict, and that the live stream and a
 * reload agree on how a turn with an open question stands.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { makeStream, mockSessionHistory, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"
import { IllegalTransition } from "@/lib/machine"
import { openQuestion } from "@/stores/useAgentStore/question-state"
import { RUN_IDLE, isRunLive, reconcileSnapshot, runMachine, runOf, type SnapshotInput } from "@/stores/useAgentStore/run-state"

beforeEach(resetAsyncStore)

describe("session run machine", () => {
  it("lists exactly these moves", () => {
    expect(runMachine.moves()).toEqual([
      ["idle", "start"],
      ["idle", "report"],
      ["idle", "snapshot"],
      ["idle", "end"],
      ["idle", "row_unmarked"],
      ["idle", "reset"],
      ["running", "start"],
      ["running", "report"],
      ["running", "snapshot"],
      ["running", "end"],
      ["running", "row_marked"],
      ["running", "row_unmarked"],
      ["running", "reset"],
    ])
  })

  it("refuses to mark the sidebar row of a session that runs nothing", () => {
    expect(() => runMachine.transition(RUN_IDLE, { type: "row_marked" })).toThrow(IllegalTransition)
  })

  it("starts a turn the client began, and keeps it until no agent is live", () => {
    const started = runMachine.transition(RUN_IDLE, { type: "start" })
    expect(isRunLive(started)).toBe(true)
    expect(isRunLive(runMachine.transition(started, { type: "report", live: true }))).toBe(true)
    expect(runMachine.transition(started, { type: "report", live: false })).toEqual(RUN_IDLE)
  })

  it("forgets the row mark when the turn ends, so the next turn patches the row again", () => {
    const marked = runMachine.transition(runOf(true), { type: "row_marked" })
    expect(marked).toEqual({ kind: "running", rowMarked: true })
    const ended = runMachine.transition(marked, { type: "end" })
    expect(runMachine.transition(ended, { type: "start" })).toEqual({ kind: "running", rowMarked: false })
  })
})

describe("reconcileSnapshot", () => {
  const base: SnapshotInput = {
    leadRunning: false,
    memberRunning: false,
    awaitingAnswer: false,
    leadKeepsLive: false,
    believedRunning: false,
    leadStatus: "idle",
  }

  it("takes the page's word when the client holds nothing newer", () => {
    expect(reconcileSnapshot({ ...base, leadRunning: true })).toEqual({
      run: { type: "snapshot", live: true },
      leadStatus: "working",
      row: "running",
    })
  })

  it("keeps a turn with an open question live and the lead waiting, even when the stream forgot the turn", () => {
    expect(reconcileSnapshot({ ...base, awaitingAnswer: true })).toEqual({
      run: { type: "snapshot", live: true },
      leadStatus: "waiting_input",
      row: null,
    })
  })

  it("clears the row of a turn the client took for running when the page says it ended", () => {
    expect(reconcileSnapshot({ ...base, believedRunning: true }).row).toBe("stopped")
  })

  it("leaves newer live content alone, except to show the lead working when both sides say it runs", () => {
    const live = { ...base, leadKeepsLive: true, leadRunning: true }
    expect(reconcileSnapshot({ ...live, believedRunning: true })).toEqual({ run: null, leadStatus: "working", row: "running" })
    // The client saw the turn end (a `done` during the fetch): the live frames win.
    expect(reconcileSnapshot({ ...live, believedRunning: false })).toEqual({ run: null, leadStatus: null, row: "running" })
    // A lead that failed or parked since the page was read is newer than the page.
    expect(reconcileSnapshot({ ...live, believedRunning: true, leadStatus: "error" }).leadStatus).toBeNull()
  })
})

describe("done with a question still open", () => {
  const question = {
    question_id: "q-1",
    session_id: "session-a",
    tool_call_id: "call-1",
    questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }],
  }

  function stateOf() {
    const s = useAgentStore.getState()
    return { lead: s.agentStreams.lead?.status, live: isRunLive(s.sessionRun), question: openQuestion(s)?.id ?? null }
  }

  it("keeps the lead waiting for the answer and the turn live", () => {
    useAgentStore.setState({ sessionId: "session-a", leadName: "lead", agentStreams: { lead: makeStream({ status: "working" as const }) } })
    const send = useAgentStore.getState()._handleSSEEvent
    send("agent_status", { agent: "lead", status: "working" })
    send("question_asked", question)
    send("agent_status", { agent: "lead", status: "waiting_input" })
    useAgentStore.getState()._drainCacheInvalidations()

    send("done", {})

    expect(stateOf()).toEqual({ lead: "waiting_input", live: true, question: "q-1" })
    // The sidebar row keeps its needs-input mark: no "stopped running" patch.
    expect(useAgentStore.getState()._drainCacheInvalidations()).not.toContainEqual({ kind: "session_running", sessionId: "session-a", running: false })
  })

  for (const running of [true, false]) {
    it(`reads the same after a reload (server running=${running})`, async () => {
      mockSessionHistory.mockImplementation(() =>
        Promise.resolve({
          lead: { id: "session-a", agent_name: "lead", title: null, created_at: null, updated_at: null, sub_sessions: [], messages: [], running },
          members: [],
          has_more: false,
          next_cursor: null,
          pending_question: { id: question.question_id, session_id: question.session_id, tool_call_id: question.tool_call_id, questions: question.questions },
        }),
      )

      await useAgentStore.getState().loadSession("session-a")

      expect(stateOf()).toEqual({ lead: "waiting_input", live: true, question: "q-1" })
    })
  }
})
