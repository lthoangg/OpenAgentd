/**
 * Most tools' output stays on the server: the live `tool_end` and history
 * rows say how big it was (`result_omitted`, `result_bytes`) and the card
 * fetches it when opened. The card must still finish, and know it has a
 * result to fetch rather than an empty one.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { useAgentStore } from "@/stores/useAgentStore"
import { applyOrphanToolResults, parseAgentBlocks } from "@/utils/messages"
import type { OrphanToolResult } from "@/utils/messages"
import type { MessageResponse } from "@/api/types"

function row(fields: Partial<MessageResponse> & Record<string, unknown>): MessageResponse {
  return { id: "m", role: "assistant", content: null, reasoning_content: null, tool_calls: null, tool_call_id: null, name: null, extra: null, created_at: "2026-11-05T00:00:00Z", attachments: null, ...fields } as MessageResponse
}

const call = row({ id: "a1", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.rs\"}" } }] })
const leftOut = row({ id: "t1", role: "tool", tool_call_id: "c1", name: "read", content: null, result_omitted: true, result_bytes: 1234, extra: { duration_ms: 7 }, created_at: "2026-11-05T00:00:01Z" })

describe("a tool result left on the server", () => {
  beforeEach(() => {
    useAgentStore.setState({ agentStreams: {}, agentNames: [], leadName: "lead", sessionId: "s1", cacheInvalidations: [] })
  })

  it("finishes the live card and records the size to fetch", () => {
    const emit = useAgentStore.getState()._handleSSEEvent
    emit("tool_call", { agent: "lead", name: "read", tool_call_id: "c1" })
    emit("tool_start", { agent: "lead", name: "read", tool_call_id: "c1", arguments: "{}" })
    emit("tool_end", { agent: "lead", name: "read", tool_call_id: "c1", result: null, metadata: { duration_ms: 7, result_omitted: true, result_bytes: 1234 } })
    const card = useAgentStore.getState().agentStreams.lead.currentBlocks.find((b) => b.toolCallId === "c1")!
    expect([card.toolDone, card.toolResult, card.toolResultBytes, card.serverDurationMs]).toEqual([true, undefined, 1234, 7])
  })

  it("keeps a result that rides with the event", () => {
    const emit = useAgentStore.getState()._handleSSEEvent
    emit("tool_call", { agent: "lead", name: "patch", tool_call_id: "c2" })
    emit("tool_end", { agent: "lead", name: "patch", tool_call_id: "c2", result: "Success.", metadata: {} })
    const card = useAgentStore.getState().agentStreams.lead.currentBlocks.find((b) => b.toolCallId === "c2")!
    expect([card.toolResult, card.toolResultBytes]).toEqual(["Success.", undefined])
  })

  it("finishes a history card with no result text", () => {
    const card = parseAgentBlocks([call, leftOut]).find((b) => b.type === "tool")!
    expect([card.toolDone, card.toolResult, card.toolResultBytes, card.serverDurationMs]).toEqual([true, undefined, 1234, 7])
  })

  it("finishes a confirmed card from an orphan row that left its result out", () => {
    const orphans: Record<string, OrphanToolResult> = {}
    parseAgentBlocks([leftOut], orphans)
    const [card] = applyOrphanToolResults([{ id: "b", type: "tool", content: "", toolName: "read", toolCallId: "c1", toolDone: false }], orphans)
    expect([card.toolDone, card.toolResult, card.toolResultBytes]).toEqual([true, undefined, 1234])
  })
})
