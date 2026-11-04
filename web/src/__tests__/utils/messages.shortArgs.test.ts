/**
 * History sends a few tools' arguments short, with the full size beside
 * the call (`arguments_bytes`); the block keeps that size so the card knows
 * to fetch the full arguments when opened.
 */
import { describe, it, expect } from "bun:test"
import { parseAgentBlocks } from "@/utils/messages"
import type { MessageResponse } from "@/api/types"

function assistant(toolCalls: MessageResponse["tool_calls"]): MessageResponse {
  return { id: "a1", session_id: "s", role: "assistant", content: null, reasoning_content: null, tool_calls: toolCalls, tool_call_id: null, name: null, is_summary: false, is_hidden: false, extra: null, created_at: "2026-11-05T00:00:00Z", attachments: null } as MessageResponse
}

describe("short tool arguments in history", () => {
  it("records the full size of arguments sent short", () => {
    const blocks = parseAgentBlocks([
      assistant([
        { id: "c1", type: "function", function: { name: "shell", arguments: "{\"description\":\"Run tests\"}" }, arguments_bytes: 64 },
        { id: "c2", type: "function", function: { name: "read", arguments: "{\"path\":\"a.rs\"}" } },
      ]),
    ])
    const byId = Object.fromEntries(blocks.filter((b) => b.type === "tool").map((b) => [b.toolCallId, b]))
    expect(byId.c1.toolArgsBytes).toBe(64)
    expect(JSON.parse(byId.c1.toolArgs!)).toEqual({ description: "Run tests" })
    expect(byId.c2.toolArgsBytes).toBeUndefined()
  })
})
