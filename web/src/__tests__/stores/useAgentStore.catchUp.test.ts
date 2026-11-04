/**
 * Foreground resume on the phone: catch up a live turn with the rows saved
 * since the last sync instead of re-downloading the whole newest page.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test"

/* eslint-disable @typescript-eslint/no-explicit-any */
let streamCallbacks: any = null
const mockSessionHistorySince = mock(async () => ({ lead: { messages: [], running: true }, members: [], truncated: false })) as any
const mockSessionHistory = mock(async () => { throw new Error("a resume must not take the full page") }) as any
;(mock as any).module("@/api/client", () => ({
  agentStream: mock((_sid: any, callbacks: any) => { streamCallbacks = callbacks }),
  sessionHistorySince: mockSessionHistorySince,
  sessionHistory: mockSessionHistory,
  agentStatus: mock(async () => ({ lead: null, members: [] })),
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

const SYNCED = "01a18c00-0000-7000-8000-000000000001"

function toolRow(callId: string, content: string) {
  return { id: `r-${callId}`, role: "tool", content, tool_call_id: callId, name: "shell", created_at: "2026-10-30T12:00:02Z" }
}

function assistantCalling(callId: string) {
  return { id: `a-${callId}`, role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "shell", arguments: "{}" } }], created_at: "2026-10-30T12:00:01Z" }
}

function liveTool(callId: string): ContentBlock {
  return { id: `t-${callId}`, type: "tool", content: "", toolName: "shell", toolCallId: callId, toolDone: false }
}

function delta(messages: unknown[], extra: Record<string, unknown> = {}) {
  return { lead: { messages, running: true }, members: [], truncated: false, ...extra }
}

function leadBlocks() {
  const lead = useAgentStore.getState().agentStreams.lead
  return { blocks: lead.blocks, currentBlocks: lead.currentBlocks }
}

beforeEach(() => {
  streamCallbacks = null
  mockSessionHistorySince.mockClear()
  mockSessionHistory.mockClear()
  mockSessionHistorySince.mockImplementation(async () => delta([]))
  useAgentStore.setState({
    sessionId: "s1",
    _workspace: "/repo",
    leadName: "lead",
    agentNames: ["lead"],
    isAgentWorking: true,
    _syncedThrough: SYNCED,
    agentStreams: {
      lead: {
        ...useAgentStore.getState().agentStreams.lead,
        blocks: [{ id: "u1", type: "user", content: "go" }],
        currentBlocks: [{ id: "x1", type: "text", content: "Running two commands." }, liveTool("call-1"), liveTool("call-2")],
        _unsyncedBlockIds: [],
        status: "working",
      } as never,
    },
  })
})

describe("catchUpLiveTurn", () => {
  it("reattaches with only the rows since the last sync when nothing is missing", async () => {
    const verdict = await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")

    expect(verdict).toBe("attach")
    expect(mockSessionHistorySince).toHaveBeenCalledWith("s1", SYNCED)
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })

  it("finishes the shown tool cards whose results were saved while away", async () => {
    mockSessionHistorySince.mockImplementation(async () => delta([assistantCalling("call-1"), toolRow("call-1", "first done")]))

    const verdict = await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")

    expect(verdict).toBe("attach")
    const tools = leadBlocks().currentBlocks.filter((b) => b.type === "tool")
    expect(tools.map((b) => [b.toolCallId, b.toolDone, b.toolResult])).toEqual([
      ["call-1", true, "first done"],
      ["call-2", false, undefined],
    ])
  })

  it("finishes a member's shown tool card from the member rows", async () => {
    useAgentStore.setState((s) => ({
      agentNames: ["lead", "worker"],
      agentStreams: {
        ...s.agentStreams,
        worker: { ...s.agentStreams.lead, blocks: [], currentBlocks: [liveTool("call-9")] } as never,
      },
    }))
    mockSessionHistorySince.mockImplementation(async () => ({
      ...delta([]),
      members: [{ name: "worker", messages: [assistantCalling("call-9"), toolRow("call-9", "member done")] }],
    }))

    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("attach")
    const card = useAgentStore.getState().agentStreams.worker.currentBlocks[0]
    expect([card.toolDone, card.toolResult]).toEqual([true, "member done"])
  })

  it("asks for the full page when a whole step happened while away", async () => {
    mockSessionHistorySince.mockImplementation(async () => delta([assistantCalling("call-3"), toolRow("call-3", "unseen")]))

    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("reload")
  })

  it("asks for the full page when the turn ended while away", async () => {
    mockSessionHistorySince.mockImplementation(async () => ({ lead: { messages: [], running: false }, members: [], truncated: false }))

    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("reload")
  })

  it("asks for the full page when the client fell too far behind", async () => {
    mockSessionHistorySince.mockImplementation(async () => delta([], { truncated: true }))

    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("reload")
  })

  it("asks for the full page when the delta request fails", async () => {
    mockSessionHistorySince.mockImplementation(async () => { throw new Error("offline") })

    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("reload")
  })

  it("asks for the full page without a sync point or with the session idle", async () => {
    useAgentStore.setState({ _syncedThrough: null })
    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("reload")
    useAgentStore.setState({ _syncedThrough: SYNCED, isAgentWorking: false })
    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("reload")
    expect(mockSessionHistorySince).not.toHaveBeenCalled()
  })

  it("does nothing for a session the user left while the delta was in flight", async () => {
    mockSessionHistorySince.mockImplementation(async () => {
      useAgentStore.setState((s) => ({ sessionId: "s2", _sessionGeneration: s._sessionGeneration + 1 }))
      return delta([assistantCalling("call-1"), toolRow("call-1", "late")])
    })

    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("stale")
    expect(leadBlocks().currentBlocks.find((b) => b.toolCallId === "call-1")?.toolDone).toBe(false)
  })

  it("shows each block once after the reattach replays the step in progress", async () => {
    mockSessionHistorySince.mockImplementation(async () => delta([assistantCalling("call-1"), toolRow("call-1", "first done")]))
    expect(await useAgentStore.getState().catchUpLiveTurn("s1", "/repo")).toBe("attach")

    useAgentStore.getState().connectStream()
    // The server's replay of the step still running, then live frames.
    streamCallbacks.onEvent("agent_status", { agent: "lead", status: "working" })
    streamCallbacks.onEvent("message", { agent: "lead", text: "Running two commands." })
    streamCallbacks.onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "call-2" })
    streamCallbacks.onEvent("tool_start", { agent: "lead", name: "shell", tool_call_id: "call-2", arguments: "{}" })
    streamCallbacks.onEvent("tool_end", { agent: "lead", name: "shell", tool_call_id: "call-2", result: "second done" })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const { blocks, currentBlocks } = leadBlocks()
    const shown = [...blocks, ...currentBlocks].map((b) => [b.type, b.toolCallId ?? b.content, b.type === "tool" ? b.toolResult : undefined])
    expect(shown).toEqual([
      ["user", "go", undefined],
      ["text", "Running two commands.", undefined],
      ["tool", "call-1", "first done"],
      ["tool", "call-2", "second done"],
    ])
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })
})
