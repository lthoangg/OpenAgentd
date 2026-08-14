import { describe, it, expect } from "bun:test";
import { sumUsageFromMessages, parseTeamBlocks } from "@/utils/messages";
import type { MessageResponse } from "@/api/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: "msg-" + Math.random().toString(36).slice(2),
    session_id: "sess-1",
    role: "assistant",
    content: "hello",
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    is_summary: false,
    is_hidden: false,
    extra: null,
    created_at: new Date().toISOString(),
    attachments: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sumUsageFromMessages
// ---------------------------------------------------------------------------

describe("sumUsageFromMessages", () => {
  it("returns zeros when no messages", () => {
    const result = sumUsageFromMessages([]);
    expect(result).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it("returns zeros when no assistant messages have usage", () => {
    const msgs = [makeMsg({ extra: null }), makeMsg({ role: "user" })];
    const result = sumUsageFromMessages(msgs);
    expect(result.totalTokens).toBe(0);
  });

  it("sums single assistant message with usage", () => {
    const msgs = [makeMsg({ extra: { usage: { input: 100, output: 40, cache: 10 } } })];
    const result = sumUsageFromMessages(msgs);
    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(40);
    expect(result.totalTokens).toBe(140);
    expect(result.cachedTokens).toBe(10);
  });

  it("uses last turn input for promptTokens, sums output, uses last turn cache", () => {
    // Me input = latest turn only (context window size), output = cumulative, cache = latest
    const msgs = [
      makeMsg({ extra: { usage: { input: 50, output: 20, cache: 0 } } }),
      makeMsg({ extra: { usage: { input: 80, output: 30, cache: 5 } } }),
    ];
    const result = sumUsageFromMessages(msgs);
    expect(result.promptTokens).toBe(80);      // latest turn input only
    expect(result.completionTokens).toBe(50);  // sum: 20 + 30
    expect(result.totalTokens).toBe(130);      // latest input + total output
    expect(result.cachedTokens).toBe(5);       // latest turn cache only
  });

  it("keeps an exact running sum of cost across assistant messages", () => {
    const msgs = [
      makeMsg({ extra: { usage: { input: 10, output: 5, cost: { estimated_usd: 0.0012 } } } }),
      makeMsg({ extra: { usage: { input: 20, output: 8, cost: { estimated_usd: 0.0023 } } } }),
    ];

    expect(sumUsageFromMessages(msgs).estimatedCostUsd).toBe(0.0035);
  });

  it("restores the running session cost across 100 assistant messages", () => {
    const msgs = Array.from({ length: 100 }, (_, turn) => makeMsg({
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString(),
      extra: { usage: { input: (turn + 1) * 10, output: 5, cost: { estimated_usd: 0.0012 } } },
    }));

    expect(sumUsageFromMessages(msgs).estimatedCostUsd).toBe(0.12);
  });

  it("skips non-assistant messages", () => {
    const msgs = [
      makeMsg({ role: "user", extra: { usage: { input: 999, output: 999, cache: 0 } } }),
      makeMsg({ role: "tool", extra: { usage: { input: 999, output: 999, cache: 0 } } }),
      makeMsg({ role: "assistant", extra: { usage: { input: 10, output: 5, cache: 0 } } }),
    ];
    const result = sumUsageFromMessages(msgs);
    expect(result.promptTokens).toBe(10);
    expect(result.totalTokens).toBe(15);
  });

  it("treats missing cache field as 0", () => {
    const msgs = [makeMsg({ extra: { usage: { input: 10, output: 5 } } })];
    const result = sumUsageFromMessages(msgs);
    expect(result.cachedTokens).toBe(0);
  });

  it("skips hidden messages (not filtered here — caller responsibility)", () => {
    // sumUsageFromMessages does NOT filter is_hidden — it trusts the caller
    // parseTeamBlocks filters is_hidden; sumUsageFromMessages sums all assistant msgs
    const msgs = [makeMsg({ is_hidden: true, extra: { usage: { input: 10, output: 5, cache: 0 } } })];
    const result = sumUsageFromMessages(msgs);
    // Me still counts hidden messages — this matches DatabaseHook behaviour (all turns are stored)
    expect(result.totalTokens).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// parseTeamBlocks — basic coverage
// ---------------------------------------------------------------------------

describe("parseTeamBlocks", () => {
  it("returns empty array for empty input", () => {
    expect(parseTeamBlocks([])).toEqual([]);
  });

  it("converts user message to type:user block", () => {
    const msgs = [makeMsg({ role: "user", content: "hello team" })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("user");
    expect(blocks[0].content).toBe("hello team");
  });

  it("preserves user message model metadata while normalising routing fields", () => {
    const msgs = [makeMsg({
      role: "user",
      content: "hello team",
      extra: {
        routing: { from_agents: ["planner#1"] },
        model: "openrouter:anthropic/claude-sonnet-4.5",
        thinking_level: "medium",
      },
    })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].extra?.from_agent).toBe("planner#1");
    expect(blocks[0].extra?.model).toBe("openrouter:anthropic/claude-sonnet-4.5");
    expect(blocks[0].extra?.thinking_level).toBe("medium");
  });

  it("does not invent model metadata for legacy user messages", () => {
    const msgs = [makeMsg({ role: "user", content: "legacy", extra: null })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks[0].extra).toBeUndefined();
  });

  it("converts assistant message to text block", () => {
    const msgs = [makeMsg({ role: "assistant", content: "here is my answer" })];
    const blocks = parseTeamBlocks(msgs);
    const textBlock = blocks.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock?.content).toBe("here is my answer");
  });

  it("derives text/thinking/tool block ids from the message id instead of a random one, so re-parsing the same message is idempotent", () => {
    // A random id per parse (generateBlockId()) meant the *same* persisted
    // message produced a *different* block id on every loadSession()/
    // reconcileTurnTail() call — no stable identity for React keys or for
    // mergeBlocks' defensive id-based dedup to key off. Deriving from the
    // message's own (stable, server-issued) id fixes that for free.
    const msg = makeMsg({
      id: "msg-fixed-1",
      role: "assistant",
      content: "the answer",
      reasoning_content: "thinking it through",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "web_search", arguments: "{}" } }],
    });

    const first = parseTeamBlocks([msg]);
    const second = parseTeamBlocks([msg]);

    expect(first.map((b) => b.id)).toEqual(second.map((b) => b.id));
    // text/thinking ids trace back to the message; the tool id reuses the
    // tool call's own (already stable) id rather than the message id.
    const byType = (t: string) => first.find((b) => b.type === t);
    expect(byType("text")?.id).toContain("msg-fixed-1");
    expect(byType("thinking")?.id).toContain("msg-fixed-1");
    expect(byType("tool")?.id).toBe("tc-1");
    // thinking / text / tool blocks from the same message get distinct ids.
    expect(new Set(first.map((b) => b.id)).size).toBe(first.length);
  });

  it("uses the tool call's own id as the tool block id (already the stable toolCallId used for matching elsewhere)", () => {
    const msg = makeMsg({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc-abc", type: "function", function: { name: "web_search", arguments: "{}" } }],
    });
    const blocks = parseTeamBlocks([msg]);
    const toolBlock = blocks.find((b) => b.type === "tool");
    expect(toolBlock?.id).toBe("tc-abc");
  });

  it("converts reasoning_content to thinking block", () => {
    const msgs = [makeMsg({ role: "assistant", reasoning_content: "let me think", content: null })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks[0].type).toBe("thinking");
    expect(blocks[0].content).toBe("let me think");
  });

  it("renders summary messages as compaction divider blocks (legacy prefix stripped)", () => {
    const msgs = [makeMsg({
      is_summary: true,
      role: "assistant",
      content: "[Summary of earlier conversation]\nthe gist",
    })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("compaction");
    expect(blocks[0].extra?.state).toBe("compacted");
    // Legacy DB rows (pre-2026-05) carried this prefix — still stripped on read.
    expect(blocks[0].content).toBe("the gist");
  });

  it("renders new-style summary rows verbatim (no prefix in DB)", () => {
    const msgs = [makeMsg({
      is_summary: true,
      role: "user",
      content: "## Goal\nDo the thing.\n\n## Progress\nDone.",
    })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("compaction");
    expect(blocks[0].extra?.state).toBe("compacted");
    expect(blocks[0].content).toBe("## Goal\nDo the thing.\n\n## Progress\nDone.");
  });

  it("summary with null content produces empty compaction block", () => {
    const msgs = [makeMsg({ is_summary: true, role: "user", content: null as unknown as string })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("compaction");
    expect(blocks[0].content).toBe(""); // msg.content || '' → ""
  });

  it("two summary messages produce two compaction blocks in chronological order", () => {
    const t1 = new Date(Date.now() - 10000).toISOString();
    const t2 = new Date().toISOString();
    const msgs = [
      makeMsg({ is_summary: true, role: "user", content: "first summary", created_at: t1 }),
      makeMsg({ is_summary: true, role: "user", content: "second summary", created_at: t2 }),
    ];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("compaction");
    expect(blocks[0].content).toBe("first summary");
    expect(blocks[1].type).toBe("compaction");
    expect(blocks[1].content).toBe("second summary");
  });

  it("summary message interleaved between user and assistant keeps position", () => {
    const base = Date.now();
    const msgs = [
      makeMsg({ role: "user", content: "question", created_at: new Date(base).toISOString() }),
      makeMsg({ is_summary: true, role: "user", content: "compacted here", created_at: new Date(base + 1).toISOString() }),
      makeMsg({ role: "assistant", content: "answer", created_at: new Date(base + 2).toISOString() }),
    ];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("user");
    expect(blocks[1].type).toBe("compaction");
    expect(blocks[1].content).toBe("compacted here");
    expect(blocks[2].type).toBe("text");
  });

  it("shows hidden messages (user sees full history)", () => {
    const msgs = [makeMsg({ is_hidden: true, role: "assistant", content: "old message" })];
    expect(parseTeamBlocks(msgs)).toHaveLength(1);
  });

  it("links tool_call to tool result via tool_call_id and restores persisted duration", () => {
    const t = new Date().toISOString();
    const msgs = [
      makeMsg({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
        created_at: t,
      }),
      makeMsg({
        role: "tool",
        content: "result data",
        tool_call_id: "tc1",
        extra: { duration_ms: 321 },
        created_at: t,
      }),
    ];
    const blocks = parseTeamBlocks(msgs);
    const toolBlock = blocks.find((b) => b.type === "tool");
    expect(toolBlock).toBeDefined();
    expect(toolBlock?.toolDone).toBe(true);
    expect(toolBlock?.toolResult).toBe("result data");
    // Persisted messages use server duration for both display and metric fields
    expect(toolBlock?.durationMs).toBe(321);
    expect(toolBlock?.serverDurationMs).toBe(321);
  });

  it("does not restore invalid tool durations", () => {
    const t = new Date().toISOString();
    const msgs = [
      makeMsg({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "search", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "tc3", type: "function", function: { name: "write", arguments: "{}" } },
        ],
        created_at: t,
      }),
      makeMsg({ role: "tool", content: "string", tool_call_id: "tc1", extra: { duration_ms: "321" } as unknown as MessageResponse["extra"], created_at: t }),
      makeMsg({ role: "tool", content: "missing", tool_call_id: "tc2", extra: {}, created_at: t }),
      makeMsg({ role: "tool", content: "null", tool_call_id: "tc3", extra: null, created_at: t }),
    ];

    const blocks = parseTeamBlocks(msgs).filter((b) => b.type === "tool");

    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block.toolDone).toBe(true);
      expect(block.durationMs).toBeUndefined();
    }
  });

  it("sorts messages by created_at asc", () => {
    const earlier = new Date(Date.now() - 10000).toISOString();
    const later = new Date().toISOString();
    const msgs = [
      makeMsg({ role: "user", content: "second", created_at: later }),
      makeMsg({ role: "user", content: "first", created_at: earlier }),
    ];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks[0].content).toBe("first");
    expect(blocks[1].content).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// parseTeamBlocks — todo_manage rendering
// ---------------------------------------------------------------------------

describe("parseTeamBlocks — todo_manage rendering", () => {
  it("includes todo_manage tool calls in blocks (board mutations are visible)", () => {
    const msgs = [makeMsg({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc1", type: "function", function: { name: "todo_manage", arguments: '{"action":"create"}' } },
      ],
    })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool");
    expect(blocks[0].toolName).toBe("todo_manage");
  });

  it("includes todo_manage alongside other tool calls", () => {
    const msgs = [makeMsg({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc1", type: "function", function: { name: "todo_manage", arguments: '{"action":"create"}' } },
        { id: "tc2", type: "function", function: { name: "web_search", arguments: '{"q":"test"}' } },
      ],
    })];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.toolName)).toEqual(["todo_manage", "web_search"]);
  });

  it("links the board-state result onto the todo_manage block", () => {
    const t = new Date().toISOString();
    const msgs = [
      makeMsg({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "todo_manage", arguments: '{}' } },
        ],
        created_at: t,
      }),
      makeMsg({
        role: "tool",
        content: "[task_1] [completed] (high) claimed=executor#1 Do the thing",
        tool_call_id: "tc1",
        created_at: t,
      }),
    ];
    const blocks = parseTeamBlocks(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].toolDone).toBe(true);
    expect(blocks[0].toolResult).toBe("[task_1] [completed] (high) claimed=executor#1 Do the thing");
  });
});
