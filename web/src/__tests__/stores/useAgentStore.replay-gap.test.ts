/**
 * The gap between a history read and the stream attach that follows it.
 *
 * An attach replays only the step in progress, so a step the server saved
 * after the history was read, and finished before the attach, reached the
 * client by neither path: its tool row stayed missing until the turn ended
 * (seen on the phone app, which reloads and reattaches on every resume).
 */
import { mock, describe, it, expect, beforeEach } from "bun:test"

/* eslint-disable @typescript-eslint/no-explicit-any */
let streamCallbacks: any = null
const mockAgentStream = mock((_sid: any, callbacks: any) => { streamCallbacks = callbacks }) as any
const mockSessionHistorySince = mock(async () => ({ lead: { messages: [] }, members: [], truncated: false })) as any
;(mock as any).module("@/api/client", () => ({
  agentStream: mockAgentStream,
  sessionHistorySince: mockSessionHistorySince,
  sessionHistory: mock(async () => { throw new Error("not used") }),
  agentStatus: mock(async () => ({ lead: null, members: [] })),
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

const shownTool: ContentBlock = { id: "t1", type: "tool", content: "", toolName: "shell", toolCallId: "call-1", toolDone: true }

function savedStep(callId: string) {
  return [
    { id: `a-${callId}`, role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "shell", arguments: "{}" } }], created_at: "2026-10-30T12:00:01Z" },
    { id: `r-${callId}`, role: "tool", content: "ok", tool_call_id: callId, name: "shell", created_at: "2026-10-30T12:00:02Z" },
  ]
}

const loadSession = mock(async () => {})

beforeEach(() => {
  streamCallbacks = null
  loadSession.mockClear()
  mockSessionHistorySince.mockClear()
  useAgentStore.setState({
    sessionId: "s1",
    _workspace: "/repo",
    leadName: "lead",
    agentNames: ["lead"],
    isAgentWorking: true,
    _syncedThrough: "01a18c00-0000-7000-8000-000000000001",
    loadSession,
    agentStreams: {
      lead: {
        ...useAgentStore.getState().agentStreams.lead,
        blocks: [{ id: "u1", type: "user", content: "go" }, shownTool],
        currentBlocks: [],
        status: "working",
      } as never,
    },
  })
})

describe("history gap at a stream attach", () => {
  it("reloads history when a step finished between the history read and the attach", async () => {
    mockSessionHistorySince.mockImplementation(async () => ({ lead: { messages: savedStep("call-2") }, members: [], truncated: false }))
    useAgentStore.getState().connectStream()
    streamCallbacks.onEvent("message", { agent: "lead", text: "Running the third command." })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockSessionHistorySince).toHaveBeenCalledWith("s1", "01a18c00-0000-7000-8000-000000000001")
    expect(loadSession).toHaveBeenCalledTimes(1)
  })

  it("does not reload when the delta holds only what is already shown", async () => {
    mockSessionHistorySince.mockImplementation(async () => ({ lead: { messages: savedStep("call-1") }, members: [], truncated: false }))
    useAgentStore.getState().connectStream()
    streamCallbacks.onEvent("message", { agent: "lead", text: "Running the second command." })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockSessionHistorySince).toHaveBeenCalledTimes(1)
    expect(loadSession).not.toHaveBeenCalled()
  })

  it("checks once per attach", async () => {
    useAgentStore.getState().connectStream()
    streamCallbacks.onEvent("message", { agent: "lead", text: "a" })
    streamCallbacks.onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "call-9" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockSessionHistorySince).toHaveBeenCalledTimes(1)
  })

  it("does not check an idle session", async () => {
    useAgentStore.setState({ isAgentWorking: false })
    useAgentStore.getState().connectStream()
    streamCallbacks.onEvent("message", { agent: "lead", text: "a" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockSessionHistorySince).not.toHaveBeenCalled()
  })
})
