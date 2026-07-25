import { describe, it, expect } from "bun:test";
import {
  latestDirectUserBlockId,
  mergeBlocks,
  appendThinking,
  appendText,
  initTool,
  addTool,
  completeTool,
  appendToolOutput,
  LIVE_OUTPUT_MAX_LINES,
  startCompaction,
  appendCompactionContent,
  endCompaction,
} from "@/utils/blocks";
import type { ContentBlock } from "@/api/types";

// ---------------------------------------------------------------------------
// mergeBlocks
// ---------------------------------------------------------------------------

describe("mergeBlocks", () => {
  it("returns finalized blocks by reference when current blocks are empty", () => {
    const blocks: ContentBlock[] = [{ id: "b1", type: "text", content: "done" }];
    const result = mergeBlocks(blocks, []);
    expect(result).toBe(blocks);
  });

  it("returns current blocks by reference when finalized blocks are empty", () => {
    const currentBlocks: ContentBlock[] = [{ id: "c1", type: "text", content: "live" }];
    const result = mergeBlocks([], currentBlocks);
    expect(result).toBe(currentBlocks);
  });

  it("returns a merged copy when both arrays contain blocks", () => {
    const blocks: ContentBlock[] = [{ id: "b1", type: "text", content: "done" }];
    const currentBlocks: ContentBlock[] = [{ id: "c1", type: "text", content: "live" }];
    const result = mergeBlocks(blocks, currentBlocks);
    expect(result).not.toBe(blocks);
    expect(result).not.toBe(currentBlocks);
    expect(result).toEqual([...blocks, ...currentBlocks]);
  });
});

// ---------------------------------------------------------------------------
// latestDirectUserBlockId
// ---------------------------------------------------------------------------

describe("latestDirectUserBlockId", () => {
  it("returns undefined for empty blocks", () => {
    expect(latestDirectUserBlockId([])).toBeUndefined();
  });

  it("returns the latest direct user block id", () => {
    const blocks: ContentBlock[] = [
      { id: "u1", type: "user", content: "first" },
      { id: "t1", type: "text", content: "answer" },
      { id: "u2", type: "user", content: "second" },
    ];

    expect(latestDirectUserBlockId(blocks)).toBe("u2");
  });

  it("ignores user blocks emitted by agents", () => {
    const blocks: ContentBlock[] = [
      { id: "u1", type: "user", content: "direct" },
      { id: "agent-u", type: "user", content: "agent", extra: { from_agent: "worker" } },
    ];

    expect(latestDirectUserBlockId(blocks)).toBe("u1");
  });

  it("returns undefined when there are no direct user blocks", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "text", content: "answer" },
      { id: "agent-u", type: "user", content: "agent", extra: { from_agent: "worker" } },
    ];

    expect(latestDirectUserBlockId(blocks)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// appendThinking
// ---------------------------------------------------------------------------

describe("appendThinking", () => {
  it("creates new thinking block when blocks is empty", () => {
    const result = appendThinking([], "hello");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("thinking");
    expect(result[0].content).toBe("hello");
  });

  it("appends to last thinking block", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "thinking", content: "hello" }];
    const result = appendThinking(blocks, " world");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello world");
  });

  it("creates new block when last is text type", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "text", content: "hello" }];
    const result = appendThinking(blocks, "thought");
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("thinking");
  });

  it("preserves existing blocks", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "text", content: "first" },
      { id: "t2", type: "thinking", content: "thought" },
    ];
    const result = appendThinking(blocks, " more");
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe("thought more");
  });
});

// ---------------------------------------------------------------------------
// appendText
// ---------------------------------------------------------------------------

describe("appendText", () => {
  it("creates new text block when empty", () => {
    const result = appendText([], "hello");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].content).toBe("hello");
  });

  it("appends to last text block", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "text", content: "hello" }];
    const result = appendText(blocks, " world");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello world");
  });

  it("creates new text block when last is thinking", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "thinking", content: "hmm" }];
    const result = appendText(blocks, "answer");
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("text");
  });

  it("creates new text block when last is tool", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "tool", content: "", toolName: "search", toolDone: false }];
    const result = appendText(blocks, "result");
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// initTool
// ---------------------------------------------------------------------------

describe("initTool", () => {
  it("adds pending tool block with realtime start timestamp", () => {
    const before = Date.now();
    const result = initTool([], "web_search", "tc1");
    const after = Date.now();
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool");
    expect(result[0].toolName).toBe("web_search");
    expect(result[0].toolDone).toBe(false);
    expect(result[0].toolCallId).toBe("tc1");
    expect(result[0].toolArgs).toBeUndefined();
    expect(result[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(result[0].startedAt).toBeLessThanOrEqual(after);
  });

  it("appends to existing blocks", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "text", content: "hi" }];
    const result = initTool(blocks, "read_file");
    expect(result).toHaveLength(2);
  });

  it("skips duplicate — same toolCallId already exists (reconnect replay dedup)", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolDone: false, toolCallId: "tc1" },
    ];
    const result = initTool(blocks, "web_search", "tc1");
    expect(result).toHaveLength(1); // no duplicate added
    expect(result).toBe(blocks);    // initTool returns original array ref unchanged
  });

  it("adds new block when toolCallId differs", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolDone: false, toolCallId: "tc1" },
    ];
    const result = initTool(blocks, "web_search", "tc2");
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// addTool
// ---------------------------------------------------------------------------

describe("addTool", () => {
  it("fills args on matching block by toolCallId", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolArgs: undefined, toolDone: false, toolCallId: "tc1" },
    ];
    const result = addTool(blocks, "web_search", '{"q":"test"}', "tc1");
    expect(result[0].toolArgs).toBe('{"q":"test"}');
    expect(result[0].toolDone).toBe(false);
  });

  it("skips args update if block already has args (reconnect replay dedup)", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolArgs: '{"q":"original"}', toolDone: false, toolCallId: "tc1" },
    ];
    const result = addTool(blocks, "web_search", '{"q":"replay"}', "tc1");
    expect(result[0].toolArgs).toBe('{"q":"original"}'); // Me keep original
    expect(result).toHaveLength(1); // no duplicate added
  });

  it("fills args on matching block by name when no toolCallId", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolArgs: undefined, toolDone: false },
    ];
    const result = addTool(blocks, "web_search", '{"q":"test"}');
    expect(result[0].toolArgs).toBe('{"q":"test"}');
  });

  it("creates new block as fallback when no match found", () => {
    const result = addTool([], "web_search", '{"q":"x"}', "tc-missing");
    expect(result).toHaveLength(1);
    expect(result[0].toolArgs).toBe('{"q":"x"}');
  });

  it("matches last incomplete block by name in LIFO order", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolArgs: undefined, toolDone: false, toolCallId: "tc-first" },
      { id: "t2", type: "tool", content: "", toolName: "web_search", toolArgs: undefined, toolDone: false, toolCallId: "tc-second" },
    ];
    const result = addTool(blocks, "web_search", '{"q":"x"}', "tc-second");
    // Only tc-second gets args
    expect(result[0].toolArgs).toBeUndefined();
    expect(result[1].toolArgs).toBe('{"q":"x"}');
  });
});

// ---------------------------------------------------------------------------
// completeTool
// ---------------------------------------------------------------------------

describe("completeTool", () => {
  it("marks tool done by toolCallId and stores duration", () => {
    const startedAt = 1000;
    const completedAt = 1456;
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolDone: false, toolCallId: "tc1", startedAt },
    ];
    const result = completeTool(blocks, "web_search", "tc1", "results", 500, undefined, completedAt);
    expect(result[0].toolDone).toBe(true);
    expect(result[0].toolResult).toBe("results");
    // durationMs is client elapsed (completedAt - startedAt), not the server value
    expect(result[0].durationMs).toBe(456);
    // server execution time stored separately
    expect(result[0].serverDurationMs).toBe(500);
  });

  it("falls back to serverDurationMs for durationMs when startedAt is absent", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolDone: false, toolCallId: "tc1" },
    ];
    const result = completeTool(blocks, "web_search", "tc1", "results", 456);
    expect(result[0].toolDone).toBe(true);
    expect(result[0].serverDurationMs).toBe(456);
    // No startedAt → durationMs falls back to existing block.durationMs (undefined here)
    expect(result[0].durationMs).toBeUndefined();
  });

  it("falls back to name when toolCallId not matched", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolDone: false, toolCallId: "other-id" },
    ];
    const result = completeTool(blocks, "web_search", undefined, "ok");
    expect(result[0].toolDone).toBe(true);
  });

  it("handles parallel calls — marks correct one by toolCallId", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolDone: false, toolCallId: "tc-A" },
      { id: "t2", type: "tool", content: "", toolName: "web_search", toolDone: false, toolCallId: "tc-B" },
    ];
    const result = completeTool(blocks, "web_search", "tc-A", "result-A");
    expect(result[0].toolDone).toBe(true);
    expect(result[0].toolResult).toBe("result-A");
    expect(result[1].toolDone).toBe(false);
  });

  it("returns blocks unchanged when no match", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "text", content: "hi" }];
    const result = completeTool(blocks, "web_search", "tc1", "ok");
    expect(result).toEqual(blocks);
  });

  it("skips if block already done (reconnect replay dedup)", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "web_search", toolDone: true, toolResult: "original", toolCallId: "tc1" },
    ];
    const result = completeTool(blocks, "web_search", "tc1", "replay");
    expect(result[0].toolResult).toBe("original"); // Me keep original, not overwrite
    expect(result).toHaveLength(1); // no duplicate added
  });
});

// ---------------------------------------------------------------------------
// appendToolOutput
// ---------------------------------------------------------------------------

describe("appendToolOutput", () => {
  it("appends output to matching tool block", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "shell", toolDone: false, toolCallId: "tc1", toolOutput: "hello" },
    ];
    const result = appendToolOutput(blocks, "shell", "tc1", " world");
    expect(result[0].toolOutput).toBe("hello world");
  });

  it("truncates live tool output to recent lines when it gets too large", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "shell", toolDone: false, toolCallId: "tc1", toolOutput: "" },
    ];
    // Generate more than the retained live-output line budget.
    const lines = Array.from({ length: 140 }, (_, i) => `line ${i}`).join("\n");
    const result = appendToolOutput(blocks, "shell", "tc1", lines);

    const output = result[0].toolOutput || "";
    expect(output).toContain("... [truncated live output] ...");
    const outputLines = output.split("\n");
    // Should be 1 header line + LIVE_OUTPUT_MAX_LINES lines of output
    expect(outputLines.length).toBe(LIVE_OUTPUT_MAX_LINES + 1);
    expect(outputLines[1]).toBe(`line ${140 - LIVE_OUTPUT_MAX_LINES}`);
    expect(outputLines[LIVE_OUTPUT_MAX_LINES]).toBe("line 139");
  });

  it("does not truncate when exactly at the retained-line boundary", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "shell", toolDone: false, toolCallId: "tc1", toolOutput: "" },
    ];
    // N lines (N-1 newlines) — must NOT trigger truncation.
    const lines = Array.from({ length: LIVE_OUTPUT_MAX_LINES }, (_, i) => `line ${i}`).join("\n");
    const result = appendToolOutput(blocks, "shell", "tc1", lines);
    expect(result[0].toolOutput).toBe(lines);
    expect(result[0].toolOutput).not.toContain("truncated");
  });

  it("truncates at one line over the boundary", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "shell", toolDone: false, toolCallId: "tc1", toolOutput: "" },
    ];
    const lines = Array.from({ length: LIVE_OUTPUT_MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    const result = appendToolOutput(blocks, "shell", "tc1", lines);
    const output = result[0].toolOutput || "";
    expect(output).toContain("... [truncated live output] ...");
    const outputLines = output.split("\n");
    expect(outputLines.length).toBe(LIVE_OUTPUT_MAX_LINES + 1); // header + retained lines
    expect(outputLines[1]).toBe("line 1");
    expect(outputLines[LIVE_OUTPUT_MAX_LINES]).toBe(`line ${LIVE_OUTPUT_MAX_LINES}`);
  });

  it("handles output with no newlines at all", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "shell", toolDone: false, toolCallId: "tc1", toolOutput: "" },
    ];
    const result = appendToolOutput(blocks, "shell", "tc1", "single line, no newline");
    expect(result[0].toolOutput).toBe("single line, no newline");
  });

  it("truncates by byte length even when line count is under the limit", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "shell", toolDone: false, toolCallId: "tc1", toolOutput: "" },
    ];
    // A single line far exceeding 24,000 chars — line-count check doesn't
    // fire (only 1 line), but the byte-length truncation must still apply.
    const longLine = "x".repeat(30_000);
    const result = appendToolOutput(blocks, "shell", "tc1", longLine);
    const output = result[0].toolOutput || "";
    expect(output).toContain("... [truncated live output] ...");
    expect(output.length).toBeLessThan(30_000);
    expect(output.endsWith("x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compaction lifecycle
// ---------------------------------------------------------------------------

describe("startCompaction", () => {
  it("appends a fresh compacting block", () => {
    const result = startCompaction([]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("compaction");
    expect(result[0].extra?.state).toBe("compacting");
  });

  it("appends when there are prior non-compaction blocks but no previous compaction", () => {
    // lastCompactionIndex === -1 with non-empty blocks → same append-to-tail path
    const blocks: ContentBlock[] = [
      { id: "t1", type: "text", content: "before" },
      { id: "t2", type: "text", content: "more" },
    ];
    const result = startCompaction(blocks);
    expect(result).toHaveLength(3);
    expect(result[2].type).toBe("compaction");
    expect(result[2].extra?.state).toBe("compacting");
    expect(result[0].id).toBe("t1");
    expect(result[1].id).toBe("t2");
  });

  it("is idempotent when the trailing block is already compacting (replay)", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "half", extra: { state: "compacting" } },
    ];
    const result = startCompaction(blocks);
    expect(result).toBe(blocks); // same reference, no mutation
  });

  it("still appends if the trailing compaction block already finished", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "done", extra: { state: "compacted" } },
    ];
    const result = startCompaction(blocks);
    expect(result).toHaveLength(2);
    expect(result[1].extra?.state).toBe("compacting");
  });

  // ── ordering: compaction inserted BEFORE live content blocks ─────────────
  // When summarization fires mid-turn the store holds finalized blocks that
  // already include some streaming content after the previous compaction
  // boundary.  startCompaction must insert the new marker right after the
  // last compaction block, NOT after those live blocks.

  it("appends a new compacting block after content since the previous compaction", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "old summary", extra: { state: "compacted" } },
      { id: "t1", type: "text", content: "later A" },
      { id: "t2", type: "text", content: "later B" },
    ];
    const result = startCompaction(blocks);
    expect(result).toHaveLength(4);
    expect(result.slice(0, 3).map((block) => block.id)).toEqual(["c1", "t1", "t2"]);
    expect(result[3].type).toBe("compaction");
    expect(result[3].extra?.state).toBe("compacting");
  });

  it("is idempotent on replay even when live blocks follow the compacting marker", () => {
    // [compacting, live-text]  — reconnect re-emits start; must not duplicate
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "half", extra: { state: "compacting" } },
      { id: "t1", type: "text", content: "live" },
    ];
    const result = startCompaction(blocks);
    expect(result).toBe(blocks);
    expect(result).toHaveLength(2);
  });
});

describe("appendCompactionContent", () => {
  it("appends streaming text to the trailing compacting block", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "Hello ", extra: { state: "compacting" } },
    ];
    const result = appendCompactionContent(blocks, "world");
    expect(result[0].content).toBe("Hello world");
  });

  it("drops the chunk when no compacting block exists", () => {
    const blocks: ContentBlock[] = [{ id: "t1", type: "text", content: "x" }];
    const result = appendCompactionContent(blocks, "ignored");
    expect(result).toBe(blocks);
  });

  it("does not touch a compacted (done) block", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "done", extra: { state: "compacted" } },
    ];
    const result = appendCompactionContent(blocks, " more");
    expect(result[0].content).toBe("done");
  });

  it("targets the last compacting block when multiple compaction blocks exist", () => {
    // First is compacted (old summary), second is the in-flight one
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "old", extra: { state: "compacted" } },
      { id: "c2", type: "compaction", content: "new ", extra: { state: "compacting" } },
    ];
    const result = appendCompactionContent(blocks, "delta");
    expect(result[0].content).toBe("old");   // untouched
    expect(result[1].content).toBe("new delta"); // updated
  });

  // ── ordering: compacting block is NOT the last block ─────────────────────
  // After startCompaction inserts the marker before live content, subsequent
  // summarization_content deltas must still find and update it even though
  // live text blocks sit after it in the array.

  it("updates the compacting block even when live text blocks follow it", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "so far ", extra: { state: "compacting" } },
      { id: "t1", type: "text", content: "live response" },
    ];
    const result = appendCompactionContent(blocks, "more");
    expect(result[0].content).toBe("so far more"); // compaction block updated
    expect(result[1].content).toBe("live response"); // live block untouched
    expect(result[1].id).toBe("t1");
  });

  it("preserves block order — only the compacting block changes", () => {
    const blocks: ContentBlock[] = [
      { id: "u1", type: "user", content: "question" },
      { id: "c1", type: "compaction", content: "A", extra: { state: "compacting" } },
      { id: "t1", type: "text", content: "streaming" },
    ];
    const result = appendCompactionContent(blocks, "B");
    expect(result.map((b) => b.id)).toEqual(["u1", "c1", "t1"]);
    expect(result[1].content).toBe("AB");
    expect(result[0].content).toBe("question");
    expect(result[2].content).toBe("streaming");
  });
});

describe("endCompaction", () => {
  it("flips the trailing compacting block to compacted and overwrites content", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "partial", extra: { state: "compacting" } },
    ];
    const result = endCompaction(blocks, "final summary", false);
    expect(result[0].extra?.state).toBe("compacted");
    expect(result[0].content).toBe("final summary");
    expect(result[0].extra?.error).toBeUndefined();
  });

  it("sets error flag on failure", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "", extra: { state: "compacting" } },
    ];
    const result = endCompaction(blocks, "", true);
    expect(result[0].extra?.state).toBe("compacted");
    expect(result[0].extra?.error).toBe(true);
  });

  it("synthesizes a completed block when no in-flight one exists", () => {
    const result = endCompaction([], "summary", false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("compaction");
    expect(result[0].extra?.state).toBe("compacted");
    expect(result[0].content).toBe("summary");
  });

  it("keeps existing content when summary is empty", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "streamed", extra: { state: "compacting" } },
    ];
    const result = endCompaction(blocks, "", false);
    expect(result[0].content).toBe("streamed");
  });

  // ── ordering: compacting block is NOT the last block ─────────────────────
  // endCompaction must flip the right block and leave live blocks in place.

  it("flips the compacting block even when live text blocks follow it", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "streamed summary", extra: { state: "compacting" } },
      { id: "t1", type: "text", content: "live response" },
    ];
    const result = endCompaction(blocks, "final summary", false);
    expect(result).toHaveLength(2);
    expect(result[0].extra?.state).toBe("compacted");
    expect(result[0].content).toBe("final summary");
    expect(result[1].id).toBe("t1"); // live block position unchanged
    expect(result[1].content).toBe("live response");
  });

  it("preserves full block order after end", () => {
    const blocks: ContentBlock[] = [
      { id: "u1", type: "user", content: "question" },
      { id: "c1", type: "compaction", content: "partial", extra: { state: "compacting" } },
      { id: "t1", type: "text", content: "streaming" },
      { id: "t2", type: "text", content: "more" },
    ];
    const result = endCompaction(blocks, "done", false);
    expect(result.map((b) => b.id)).toEqual(["u1", "c1", "t1", "t2"]);
    expect(result[1].extra?.state).toBe("compacted");
    expect(result[1].content).toBe("done");
  });

  it("targets the last compacting block when a previous compacted block also exists", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "old summary", extra: { state: "compacted" } },
      { id: "c2", type: "compaction", content: "partial", extra: { state: "compacting" } },
    ];
    const result = endCompaction(blocks, "final", false);
    expect(result[0].content).toBe("old summary");   // untouched
    expect(result[0].extra?.state).toBe("compacted");
    expect(result[1].content).toBe("final");          // updated
    expect(result[1].extra?.state).toBe("compacted");
  });

  it("error flag set even when live blocks follow the compacting block", () => {
    const blocks: ContentBlock[] = [
      { id: "c1", type: "compaction", content: "partial", extra: { state: "compacting" } },
      { id: "t1", type: "text", content: "live" },
    ];
    const result = endCompaction(blocks, "", true);
    expect(result[0].extra?.state).toBe("compacted");
    expect(result[0].extra?.error).toBe(true);
    expect(result[1].id).toBe("t1"); // live block untouched
  });
});
