import { describe, it, expect, beforeEach } from "bun:test";
import { useAgentStore } from "@/stores/useAgentStore";
import type { ContentBlock } from "@/api/types";

// Me reset store before each test
const INITIAL = {
  agentStreams: {},
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sidebarOpen: false,
  sessionId: null,
  isAgentWorking: false,
  isContinuing: false,
  isConnected: false,
  error: null,
  _pendingMessages: [] as import('@/stores/useAgentStore').PendingMessage[],
  _sessionGeneration: 0,
  cacheInvalidations: [],
  _abortController: null,
  _reconnectTimer: null as ReturnType<typeof setTimeout> | null,
};

beforeEach(() => {
  useAgentStore.setState(INITIAL);
});

function makeStream(overrides: object = {}) {
  return {
    blocks: [] as ContentBlock[],
    currentBlocks: [] as ContentBlock[],
    status: "idle" as const,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null,
    lastError: null,
    currentText: "",
    currentThinking: "",
    ...overrides,
  };
}

// ── newSession ────────────────────────────────────────────────────────────────

describe("newSession", () => {
  it("clears sessionId and resets working state", () => {
    useAgentStore.setState({ sessionId: "old-sid", isAgentWorking: true });
    useAgentStore.getState().newSession();
    const s = useAgentStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.isAgentWorking).toBe(false);
  });

  it("resets agent blocks and returns the live roster to the lead", () => {
    useAgentStore.setState({
      leadName: "lead",
      agentNames: ["lead", "worker"],
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "b1", type: "text" as const, content: "old" }] }),
        worker: makeStream({ status: "working" }),
      },
    });
    useAgentStore.getState().newSession();
    const s = useAgentStore.getState();
    expect(s.agentNames).toEqual(["lead"]);
    expect(s.agentStreams.lead.blocks).toHaveLength(0);
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(0);
    expect(s.agentStreams.worker).toBeUndefined();
  });

  it("bumps _sessionGeneration", () => {
    const before = useAgentStore.getState()._sessionGeneration;
    useAgentStore.getState().newSession();
    expect(useAgentStore.getState()._sessionGeneration).toBe(before + 1);
  });

  it("aborts the active stream when starting a new session", () => {
    const abort = new AbortController();
    useAgentStore.setState({
      sessionId: "streaming-session",
      isConnected: true,
      _abortController: abort,
    });

    useAgentStore.getState().newSession();

    const s = useAgentStore.getState();
    expect(abort.signal.aborted).toBe(true);
    expect(s._abortController).toBeNull();
    expect(s.isConnected).toBe(false);
  });
});

// ── beginResolvedSession ────────────────────────────────────────────────────

describe("beginResolvedSession", () => {
  it("sets the persisted session id and model settings", () => {
    useAgentStore.setState({
      sessionId: "old-sid",
      sessionModel: "old:model",
      sessionThinkingLevel: "low",
      isConnected: true,
    });

    useAgentStore.getState().beginResolvedSession("new-sid", {
      workspace: "/repo/app",
      model: "openai:gpt-5.5",
      thinkingLevel: "high",
    });

    const s = useAgentStore.getState();
    expect(s.sessionId).toBe("new-sid");
    expect(s.sessionModel).toBe("openai:gpt-5.5");
    expect(s.sessionThinkingLevel).toBe("high");
    expect(s.isConnected).toBe(false);
  });

  it("keeps settings picked before a background session resolve completes", () => {
    useAgentStore.getState().setSessionModelSettings("anthropic:claude-sonnet", "high")

    useAgentStore.getState().beginResolvedSession("new-sid", {
      workspace: "/repo/app",
      model: "openai:gpt-4o",
      thinkingLevel: "low",
    })

    const s = useAgentStore.getState()
    expect(s.sessionId).toBe("new-sid")
    expect(s.sessionModel).toBe("anthropic:claude-sonnet")
    expect(s.sessionThinkingLevel).toBe("high")
  })

  it("drops the previous session's live stream when switching to another session", () => {
    const abort = new AbortController();
    useAgentStore.setState({
      sessionId: "session-a",
      sessionTitle: "Session A",
      leadName: "lead",
      agentNames: ["lead"],
      isAgentWorking: true,
      isConnected: true,
      _abortController: abort,
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentText: "streaming in A",
          currentBlocks: [{ id: "b1", type: "text" as const, content: "streaming in A" }],
        }),
      },
    });

    useAgentStore.getState().beginResolvedSession("session-b", { workspace: "/repo/app" });

    const s = useAgentStore.getState();
    expect(s.sessionId).toBe("session-b");
    expect(s.isAgentWorking).toBe(false);
    expect(s.sessionTitle).toBeNull();
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(0);
    expect(s.agentStreams.lead.currentText).toBe("");
    expect(s.agentStreams.lead.status).toBe("idle");
    expect(abort.signal.aborted).toBe(true);
  });

  it("keeps in-flight state when the resolved id matches the active session", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentNames: ["lead"],
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentBlocks: [{ id: "b1", type: "text" as const, content: "streaming in A" }],
        }),
      },
    });

    useAgentStore.getState().beginResolvedSession("session-a", { workspace: "/repo/app" });

    const s = useAgentStore.getState();
    expect(s.isAgentWorking).toBe(true);
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(1);
  });

  it("stores coding workspace and resets streams to the lead", () => {
    useAgentStore.setState({
      leadName: "lead",
      agentNames: ["lead", "worker"],
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "b1", type: "text" as const, content: "old" }] }),
        worker: makeStream({ status: "working" }),
      },
    });

    useAgentStore.getState().beginResolvedSession("coding-sid", {
      workspace: "/repo/app",
    });

    const s = useAgentStore.getState();
    expect(s.sessionId).toBe("coding-sid");
    expect(s._workspace).toBe("/repo/app");
    expect(s.agentNames).toEqual(["lead"]);
    expect(s.agentStreams.lead.blocks).toHaveLength(0);
    expect(s.agentStreams.worker).toBeUndefined();
  });
});

// ── isEmptyIdleSession ───────────────────────────────────────────────────────

describe("isEmptyIdleSession", () => {
  it("returns true for a persisted idle session with no visible blocks", () => {
    useAgentStore.setState({
      sessionId: "empty-sid",
      isAgentWorking: false,
      agentNames: ["lead", "worker"],
      agentStreams: {
        lead: makeStream(),
        worker: makeStream(),
      },
    });

    expect(useAgentStore.getState().isEmptyIdleSession()).toBe(true);
  });

  it("ignores compaction markers when checking visible blocks", () => {
    useAgentStore.setState({
      sessionId: "empty-sid",
      isAgentWorking: false,
      agentNames: ["lead"],
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "c1", type: "compaction" as const, content: "summary" }] }),
      },
    });

    expect(useAgentStore.getState().isEmptyIdleSession()).toBe(true);
  });

  it("returns false when the session has a visible message", () => {
    useAgentStore.setState({
      sessionId: "active-sid",
      isAgentWorking: false,
      agentNames: ["lead"],
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "u1", type: "user" as const, content: "hello" }] }),
      },
    });

    expect(useAgentStore.getState().isEmptyIdleSession()).toBe(false);
  });
});

// ── _handleSSEEvent: message ──────────────────────────────────────────────────

describe("_handleSSEEvent: message", () => {
  it("appends text to agent currentBlocks", () => {
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "hello" });
    const stream = useAgentStore.getState().agentStreams["lead"];
    expect(stream).toBeDefined();
    expect(stream.currentBlocks).toHaveLength(1);
    expect(stream.currentBlocks[0].content).toBe("hello");
  });

  it("appends to same text block on subsequent chunks", () => {
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "hello" });
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: " world" });
    const stream = useAgentStore.getState().agentStreams["lead"];
    expect(stream.currentBlocks).toHaveLength(1);
    expect(stream.currentBlocks[0].content).toBe("hello world");
  });

  it("isolates chunks per agent", () => {
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "lead says" });
    useAgentStore.getState()._handleSSEEvent("message", { agent: "worker", text: "worker says" });
    expect(useAgentStore.getState().agentStreams["lead"].currentBlocks[0].content).toBe("lead says");
    expect(useAgentStore.getState().agentStreams["worker"].currentBlocks[0].content).toBe("worker says");
  });

  it("adds newly-spawned agents to agentNames when stream events arrive", () => {
    useAgentStore.setState({ agentNames: ["lead"] });
    useAgentStore.getState()._handleSSEEvent("message", { agent: "executor#1", text: "hi" });
    expect(useAgentStore.getState().agentNames).toEqual(["lead", "executor#1"]);
  });
});

// ── _handleSSEEvent: thinking ─────────────────────────────────────────────────

describe("_handleSSEEvent: thinking", () => {
  it("creates thinking block", () => {
    useAgentStore.getState()._handleSSEEvent("thinking", { agent: "lead", text: "let me think" });
    const stream = useAgentStore.getState().agentStreams["lead"];
    expect(stream.currentBlocks[0].type).toBe("thinking");
    expect(stream.currentBlocks[0].content).toBe("let me think");
  });
});

// ── _handleSSEEvent: tool lifecycle ──────────────────────────────────────────

describe("_handleSSEEvent: tool lifecycle", () => {
  it("tool_call creates pending tool block", () => {
    useAgentStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc1" });
    const block = useAgentStore.getState().agentStreams["lead"].currentBlocks[0];
    expect(block.type).toBe("tool");
    expect(block.toolDone).toBe(false);
    expect(block.toolCallId).toBe("tc1");
  });

  it("tool_start fills args", () => {
    useAgentStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc1" });
    useAgentStore.getState()._handleSSEEvent("tool_start", { agent: "lead", name: "web_search", tool_call_id: "tc1", arguments: '{"q":"test"}' });
    const block = useAgentStore.getState().agentStreams["lead"].currentBlocks[0];
    expect(block.toolArgs).toBe('{"q":"test"}');
  });

  it("tool_end marks done with result", () => {
    useAgentStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc1" });
    useAgentStore.getState()._handleSSEEvent("tool_start", { agent: "lead", name: "web_search", tool_call_id: "tc1", arguments: "{}" });
    useAgentStore.getState()._handleSSEEvent("tool_end", { agent: "lead", name: "web_search", tool_call_id: "tc1", result: "results" });
    const block = useAgentStore.getState().agentStreams["lead"].currentBlocks[0];
    expect(block.toolDone).toBe(true);
    expect(block.toolResult).toBe("results");
  });

  // A mid-turn loadSession can reconcile a still-executing tool card into the
  // confirmed `blocks` (the assistant row with tool_calls persists before the
  // tool finishes). Later live events must reach that card instead of
  // vanishing — otherwise it renders as "running" forever until a reload.
  describe("events for a card already reconciled into confirmed blocks", () => {
    const seedConfirmedRunningTool = () => {
      useAgentStore.setState({
        leadName: "lead",
        agentNames: ["lead"],
        agentStreams: {
          lead: makeStream({
            status: "working",
            blocks: [{
              id: "persisted-tool",
              type: "tool" as const,
              content: "",
              toolName: "shell",
              toolArgs: '{"command":"ls"}',
              toolCallId: "tc-1",
              toolDone: false,
            }],
          }),
        },
      });
    };

    it("tool_end completes the confirmed card instead of dropping the event", () => {
      seedConfirmedRunningTool();
      useAgentStore.getState()._handleSSEEvent("tool_end", { agent: "lead", name: "shell", tool_call_id: "tc-1", result: "ok" });
      const stream = useAgentStore.getState().agentStreams.lead;
      expect(stream.blocks[0].toolDone).toBe(true);
      expect(stream.blocks[0].toolResult).toBe("ok");
      expect(stream.currentBlocks).toHaveLength(0);
    });

    it("tool_output_delta streams onto the confirmed card", () => {
      seedConfirmedRunningTool();
      useAgentStore.getState()._handleSSEEvent("tool_output_delta", { agent: "lead", name: "shell", tool_call_id: "tc-1", text: "file.txt\n" });
      const stream = useAgentStore.getState().agentStreams.lead;
      expect(stream.blocks[0].toolOutput).toBe("file.txt\n");
      expect(stream.currentBlocks).toHaveLength(0);
    });

    it("replayed tool_call / tool_start do not spawn a duplicate live card", () => {
      seedConfirmedRunningTool();
      useAgentStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-1" });
      useAgentStore.getState()._handleSSEEvent("tool_start", { agent: "lead", name: "shell", tool_call_id: "tc-1", arguments: '{"command":"ls"}' });
      expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0);
    });

    it("tool_end without an id match in blocks still uses the live name fallback", () => {
      // Regression guard: the blocks fall-through must not complete orphaned
      // incomplete cards in history by name.
      seedConfirmedRunningTool();
      useAgentStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-2" });
      useAgentStore.getState()._handleSSEEvent("tool_end", { agent: "lead", name: "shell", tool_call_id: "tc-2", result: "second" });
      const stream = useAgentStore.getState().agentStreams.lead;
      expect(stream.blocks[0].toolDone).toBe(false);
      expect(stream.currentBlocks[0].toolDone).toBe(true);
      expect(stream.currentBlocks[0].toolResult).toBe("second");
    });
  });

});

// ── _handleSSEEvent: agent_status ────────────────────────────────────────────

describe("_handleSSEEvent: agent_status", () => {
  it("sets agent status to working", () => {
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    expect(useAgentStore.getState().agentStreams["lead"].status).toBe("working");
  });

  it("sets agent status to idle", () => {
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "idle" });
    expect(useAgentStore.getState().agentStreams["lead"].status).toBe("idle");
  });

  it("sets agent status to error with message", () => {
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "error", metadata: { message: "something broke" } });
    expect(useAgentStore.getState().agentStreams["lead"].status).toBe("error");
    expect(useAgentStore.getState().agentStreams["lead"].lastError).toBe("something broke");
  });

  it("sets agent status to offline", () => {
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "offline" });
    expect(useAgentStore.getState().agentStreams["worker"].status).toBe("offline");
  });

  it("keeps isAgentWorking=true while any other agent is still working", () => {
    // Lead + worker both working
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "working" });
    expect(useAgentStore.getState().isAgentWorking).toBe(true);

    // Worker goes idle — lead still working, global flag must stay true
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "idle" });
    const s = useAgentStore.getState();
    expect(s.agentStreams.worker.status).toBe("idle");
    expect(s.agentStreams.lead.status).toBe("working");
    expect(s.isAgentWorking).toBe(true);
  });

  it("clears isAgentWorking when the last working agent goes idle", () => {
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "working" });
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "idle" });
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "idle" });
    expect(useAgentStore.getState().isAgentWorking).toBe(false);
  });

  it("clears isAgentWorking when the last working agent errors out", () => {
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    useAgentStore.getState()._handleSSEEvent("agent_status", {
      agent: "lead",
      status: "error",
      metadata: { message: "boom" },
    });
    expect(useAgentStore.getState().isAgentWorking).toBe(false);
  });
});

// ── _handleSSEEvent: done ─────────────────────────────────────────────────────

describe("_handleSSEEvent: done", () => {
  it("flushes currentBlocks into blocks and clears working flag", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          currentBlocks: [{ id: "b1", type: "text" as const, content: "response" }],
          status: "working" as const,
        }),
      },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    const s = useAgentStore.getState();
    expect(s.isAgentWorking).toBe(false);
    expect(s.agentStreams.lead.blocks).toHaveLength(1);
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(0);
  });

  it("flushes worker blocks too", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      leadName: "lead",
      agentStreams: {
        worker: makeStream({
          currentBlocks: [{ id: "b1", type: "text" as const, content: "worker output" }],
          status: "working" as const,
        }),
      },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    const s = useAgentStore.getState();
    expect(s.agentStreams.worker.blocks).toHaveLength(1);
    expect(s.agentStreams.worker.currentBlocks).toHaveLength(0);
  });

  it("sets all agent statuses to idle", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    expect(useAgentStore.getState().agentStreams.lead.status).toBe("idle");
    expect(useAgentStore.getState().agentStreams.worker.status).toBe("idle");
  });

  it("preserves offline status on done", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      leadName: "lead",
      agentStreams: {
        worker: makeStream({ status: "offline" as const }),
      },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    expect(useAgentStore.getState().agentStreams.worker.status).toBe("offline");
  });
});

// ── _handleSSEEvent: session ──────────────────────────────────────────────────

describe("_handleSSEEvent: session", () => {
  it("sets sessionId from event data", () => {
    useAgentStore.getState()._handleSSEEvent("session", { session_id: "new-sid" });
    expect(useAgentStore.getState().sessionId).toBe("new-sid");
  });
});

// ── _handleSSEEvent: usage ────────────────────────────────────────────────────

describe("_handleSSEEvent: usage", () => {
  it("reads agent from metadata.agent (backend wire format)", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cached_tokens: 2,
      metadata: { agent: "lead" },
    });
    const usage = useAgentStore.getState().agentStreams["lead"].usage;
    expect(usage.totalTokens).toBe(15);
    expect(usage.promptTokens).toBe(10);
    expect(usage.cachedTokens).toBe(2);
  });

  it("accumulates estimated cost for the session", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      estimated_cost_usd: 0.0012,
      metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      estimated_cost_usd: 0.0023,
      metadata: { agent: "lead" },
    });

    expect(useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd).toBe(0.0035);
  });

  it("keeps a running session cost across 100 usage events", () => {
    for (let turn = 1; turn <= 100; turn += 1) {
      useAgentStore.getState()._handleSSEEvent("usage", {
        prompt_tokens: turn * 10,
        completion_tokens: 5,
        total_tokens: turn * 10 + 5,
        estimated_cost_usd: 0.0012,
        metadata: { agent: "lead" },
      });
    }

    expect(useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd).toBe(0.12);
  });

  it("session cost is always appended and never less than previous agent turn", () => {
    // Turn 1 costs 0.002
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      estimated_cost_usd: 0.002, metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    const costAfterTurn1 = useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd;
    expect(costAfterTurn1).toBe(0.002);

    // Turn 2 costs 0.0015
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 150, completion_tokens: 30, total_tokens: 180,
      estimated_cost_usd: 0.0015, metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    const costAfterTurn2 = useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd;
    expect(costAfterTurn2).toBe(0.0035);
    expect(costAfterTurn2).toBeGreaterThanOrEqual(costAfterTurn1!);

    // Turn 3 has zero/unknown cost — running cost must not decrease
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 200, completion_tokens: 40, total_tokens: 240,
      metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    const costAfterTurn3 = useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd;
    expect(costAfterTurn3).toBe(0.0035);
    expect(costAfterTurn3).toBeGreaterThanOrEqual(costAfterTurn2!);
  });

  it("running sum stays previous cost + current turn cost across a compaction", () => {
    // Turn 1 costs A.
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      estimated_cost_usd: 0.001, metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("done", {});
    // Compaction fires before turn 2 — its LLM call costs S.
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 9000, completion_tokens: 50, total_tokens: 9050,
      estimated_cost_usd: 0.0005, metadata: { agent: "lead", summarization: true },
    });
    // Turn 2 costs B.
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 150, completion_tokens: 30, total_tokens: 180,
      estimated_cost_usd: 0.002, metadata: { agent: "lead" },
    });

    // A + S + B — the compaction call is real spend and must not be dropped.
    expect(useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd).toBe(0.0035);
  });

  it("summarization usage sets promptTokens to completion_tokens so compaction reduction is immediately visible", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230,
      cached_tokens: 100, estimated_cost_usd: 0.002, metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 9000, completion_tokens: 50, total_tokens: 9050,
      cached_tokens: 8000, estimated_cost_usd: 0.0005,
      metadata: { agent: "lead", summarization: true },
    });

    const usage = useAgentStore.getState().agentStreams.lead.usage;
    // Input is displayed as the output of the summarisation turn (50 tokens)
    // so the user immediately sees the compaction usage (input) being reduced.
    expect(usage.promptTokens).toBe(50);
    expect(usage.cachedTokens).toBe(8000);
    expect(usage.cachedPercent).toBe(88.89);
    // Generation and cost are real and accumulate.
    expect(usage.completionTokens).toBe(80);
    expect(usage.totalTokens).toBe(130);
    expect(usage.estimatedCostUsd).toBe(0.0025);
  });

  it("falls back to top-level agent field", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      agent: "worker",
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      cached_tokens: 0,
    });
    const usage = useAgentStore.getState().agentStreams["worker"].usage;
    expect(usage.totalTokens).toBe(28);
  });

  it("accumulates usage across multiple events (multi-turn)", () => {
    // Me input = latest turn only, output = sum all turns, cache = latest turn
    // Turn 1: fire usage, then done closes the turn
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      cached_tokens: 0, metadata: { agent: "lead" },
    });
    useAgentStore.setState((s) => ({
      agentStreams: {
        ...s.agentStreams,
        lead: { ...s.agentStreams.lead, status: "working" as const },
      },
    }));
    useAgentStore.getState()._handleSSEEvent("done", {});
    // Turn 2: fire second usage event — completionBase now = 5
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
      cached_tokens: 3, metadata: { agent: "lead" },
    });
    const usage = useAgentStore.getState().agentStreams["lead"].usage;
    expect(usage.promptTokens).toBe(20);      // latest turn input only
    expect(usage.completionTokens).toBe(15);  // sum: 5 (turn1) + 10 (turn2)
    expect(usage.totalTokens).toBe(35);       // latest input + total output
    expect(usage.cachedTokens).toBe(3);       // latest turn cache only
  });

  it("adds live output onto a mid-turn reconcile instead of double-counting", () => {
    // A mid-turn loadSession (reconnect, tab focus) replaces usage with the
    // total summed from persisted messages — which already covers the model
    // calls this turn has completed. The next live event must add only its own
    // call's output on top.
    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          usage: {
            promptTokens: 120,
            completionTokens: 50,
            totalTokens: 170,
            cachedTokens: 0,
            estimatedCostUsd: 0.004,
          },
        }),
      },
    });

    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 150, completion_tokens: 40, total_tokens: 190,
      estimated_cost_usd: 0.002, metadata: { agent: "lead" },
    });

    const usage = useAgentStore.getState().agentStreams.lead.usage;
    expect(usage.promptTokens).toBe(150);
    expect(usage.completionTokens).toBe(90);
    expect(usage.totalTokens).toBe(240);
    expect(usage.estimatedCostUsd).toBe(0.006);
  });

  it("clears the cache count when a model call reports no cache read", () => {
    // Providers coerce a zero cache read to None (`cached_tokens or None`), so
    // `usage_to_dict` omits the key entirely. Carrying the previous call's
    // number forward made the live meter disagree with `sumUsageFromMessages`,
    // which reads the last message's cache as 0.
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 900, completion_tokens: 20, total_tokens: 920,
      cached_tokens: 768, metadata: { agent: "lead" },
    });
    expect(useAgentStore.getState().agentStreams.lead.usage.cachedTokens).toBe(768);

    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230,
      metadata: { agent: "lead" },
    });

    expect(useAgentStore.getState().agentStreams.lead.usage.cachedTokens).toBe(0);
  });

  it("does not move token counts while text streams", () => {
    // Output used to be guessed from `text.length / 4` — which also counted
    // reasoning text, and never corrected downward.
    useAgentStore.setState({ agentStreams: { lead: makeStream() } });

    useAgentStore.getState()._handleSSEEvent("message", {
      agent: "lead", text: "a".repeat(400),
    });
    useAgentStore.getState()._handleSSEEvent("thinking", {
      agent: "lead", text: "b".repeat(400),
    });

    const usage = useAgentStore.getState().agentStreams.lead.usage;
    expect(usage.completionTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });

  it("stores backend turn_total usage without changing displayed current usage", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      cached_tokens: 10, metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
      cached_tokens: 15, metadata: { agent: "lead" },
    });
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 220, completion_tokens: 50, total_tokens: 270,
      cached_tokens: 25, metadata: { agent: "lead", turn_total: true },
    });

    const usage = useAgentStore.getState().agentStreams["lead"].usage;
    // Two model calls: input is the latest call's context, output is their sum.
    expect(usage.promptTokens).toBe(120);
    expect(usage.completionTokens).toBe(50);
    expect(usage.totalTokens).toBe(170);
    expect(usage.cachedTokens).toBe(15);
    expect(usage.turnPromptTokens).toBe(220);
    expect(usage.turnCompletionTokens).toBe(50);
    expect(usage.turnTotalTokens).toBe(270);
    expect(usage.turnCachedTokens).toBe(25);
  });

  it("clears stored turn cache count when backend turn_total omits cached_tokens", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      cached_tokens: 10, metadata: { agent: "lead", turn_total: true },
    });
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
      metadata: { agent: "lead", turn_total: true },
    });

    const usage = useAgentStore.getState().agentStreams["lead"].usage;
    expect(usage.turnCachedTokens).toBe(0);
  });

  it("ignores event with no agent field", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    });
    // Me no stream created for unknown agent
    expect(Object.keys(useAgentStore.getState().agentStreams)).toHaveLength(0);
  });

  it("resets usage on newSession", () => {
    useAgentStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      cached_tokens: 5, metadata: { agent: "lead" },
    });
    useAgentStore.getState().newSession();
    expect(useAgentStore.getState().agentStreams["lead"].usage.totalTokens).toBe(0);
  });
});

// ── _handleSSEEvent: summarization ────────────────────────────────────────────

describe("_handleSSEEvent: summarization", () => {
  it("summarization_start appends a compacting block to the agent's finalized blocks", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    const stream = useAgentStore.getState().agentStreams.lead;
    expect(stream.currentBlocks).toHaveLength(0);
    expect(stream.blocks).toHaveLength(1);
    expect(stream.blocks[0].type).toBe("compaction");
    expect(stream.blocks[0].extra?.state).toBe("compacting");
  });

  it("summarization_content streams text onto the trailing compacting block", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "Hello " });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "world." });
    const blocks = useAgentStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].content).toBe("Hello world.");
    expect(blocks[0].extra?.state).toBe("compacting");
  });

  it("summarization_end flips the block to compacted and uses the final summary", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "partial" });
    useAgentStore.getState()._handleSSEEvent("summarization_end", {
      agent: "lead",
      summary: "final summary",
    });
    const blocks = useAgentStore.getState().agentStreams.lead.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].extra?.state).toBe("compacted");
    expect(blocks[0].content).toBe("final summary");
  });

  it("summarization_end with metadata.error sets the error flag", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_end", {
      agent: "lead",
      summary: "",
      metadata: { error: true },
    });
    const blocks = useAgentStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].extra?.state).toBe("compacted");
    expect(blocks[0].extra?.error).toBe(true);
  });

  it("re-emitted summarization_start during replay does not duplicate the block", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "halfway" });
    // Reconnect replay re-emits start — must not append a fresh block.
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    const blocks = useAgentStore.getState().agentStreams.lead.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("halfway");
  });

  it("places auto-triggered compaction after content already streamed in the turn", () => {
    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          blocks: [{ id: "old", type: "text" as const, content: "earlier turn" }],
          currentBlocks: [{ id: "pre-trigger", type: "text" as const, content: "streamed before trigger" }],
        }),
      },
      agentNames: ["lead"],
      leadName: "lead",
    });

    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "summary" });
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "streamed after trigger" });

    const stream = useAgentStore.getState().agentStreams.lead;
    expect(stream.blocks.map((block) => block.id)).toEqual(["old", "pre-trigger", expect.stringContaining("block-")]);
    expect(stream.blocks.map((block) => block.type)).toEqual(["text", "text", "compaction"]);
    expect(stream.blocks[2].content).toBe("summary");
    expect(stream.currentBlocks.map((block) => block.content)).toEqual(["streamed after trigger"]);
  });

  it("ignores events with empty agent", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "" });
    expect(useAgentStore.getState().agentStreams).toEqual({});
  });

  // ── full sequence with pre-trigger currentBlocks ─────────────────────────
  // Auto-compaction fires between model iterations, so currentBlocks may
  // already contain output shown earlier in this turn. That output must be
  // sealed before the marker; model output emitted after compaction remains
  // in currentBlocks and therefore renders below it.

  it("full sequence: start→content→end preserves the auto-trigger boundary", () => {
    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          blocks: [{ id: "t0", type: "text" as const, content: "earlier" }],
          currentBlocks: [
            { id: "u1", type: "user" as const, content: "hello" },
            { id: "t1", type: "text" as const, content: "live response" },
          ],
        }),
      },
      agentNames: ["lead"],
      leadName: "lead",
    });

    // start — content already shown in this turn is sealed before the marker.
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    let stream = useAgentStore.getState().agentStreams.lead;
    expect(stream.blocks.map((b) => b.type)).toEqual(["text", "user", "text", "compaction"]);
    expect(stream.blocks[3].extra?.state).toBe("compacting");
    expect(stream.currentBlocks).toHaveLength(0);

    // content — accumulates on the compacting block; later model output starts
    // a fresh live block after the marker.
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "Sum " });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "mary." });
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "post-compaction" });
    stream = useAgentStore.getState().agentStreams.lead;
    expect(stream.blocks[3].content).toBe("Sum mary.");
    expect(stream.blocks[3].extra?.state).toBe("compacting");
    expect(stream.currentBlocks[0].content).toBe("post-compaction");

    // end — compacting block flips without moving later streaming output.
    useAgentStore.getState()._handleSSEEvent("summarization_end", {
      agent: "lead",
      summary: "Final summary.",
    });
    stream = useAgentStore.getState().agentStreams.lead;
    expect(stream.blocks[3].extra?.state).toBe("compacted");
    expect(stream.blocks[3].content).toBe("Final summary.");
    expect(stream.currentBlocks[0].content).toBe("post-compaction");
  });

  it("done flushes currentBlocks AFTER compaction block — order preserved", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({
          blocks: [
            { id: "t0", type: "text" as const, content: "earlier" },
            { id: "c1", type: "compaction" as const, content: "summary", extra: { state: "compacted" } },
          ],
          currentBlocks: [
            { id: "t1", type: "text" as const, content: "post-compaction response" },
          ],
          status: "working" as const,
        }),
      },
      agentNames: ["lead"],
      leadName: "lead",
    });

    useAgentStore.getState()._handleSSEEvent("done", {});
    const stream = useAgentStore.getState().agentStreams.lead;

    // Order must be: earlier-text → compaction → post-compaction-text
    expect(stream.blocks.map((b) => b.id)).toEqual(["t0", "c1", "t1"]);
    expect(stream.blocks[1].type).toBe("compaction");
    expect(stream.blocks[2].content).toBe("post-compaction response");
    expect(stream.currentBlocks).toHaveLength(0);
  });

  it("summarization_content dropped when text field missing", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    // No text field — guard must drop the event cleanly
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead" });
    const blocks = useAgentStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].content).toBe(""); // unchanged
  });

  it("summarization_end missing summary field defaults to streamed content", () => {
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "streamed" });
    // summary field absent from event
    useAgentStore.getState()._handleSSEEvent("summarization_end", { agent: "lead" });
    const blocks = useAgentStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].extra?.state).toBe("compacted");
    // endCompaction: summary="" falsy → falls back to block.content ("streamed")
    expect(blocks[0].content).toBe("streamed");
  });

  it("second full compaction cycle appends a second block after the first compacted one", () => {
    // First cycle
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "first" });
    useAgentStore.getState()._handleSSEEvent("summarization_end", { agent: "lead", summary: "first summary" });

    // In between: some new streaming content is committed via done
    useAgentStore.setState((s) => ({
      agentStreams: {
        ...s.agentStreams,
        lead: {
          ...s.agentStreams.lead,
          currentBlocks: [{ id: "t1", type: "text" as const, content: "new turn" }],
        },
      },
    }));
    useAgentStore.getState()._handleSSEEvent("done", {});

    // Second cycle
    useAgentStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useAgentStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "second" });
    useAgentStore.getState()._handleSSEEvent("summarization_end", { agent: "lead", summary: "second summary" });

    const blocks = useAgentStore.getState().agentStreams.lead.blocks;
    const compactionBlocks = blocks.filter((b) => b.type === "compaction");
    expect(compactionBlocks).toHaveLength(2);
    expect(compactionBlocks[0].content).toBe("first summary");
    expect(compactionBlocks[1].content).toBe("second summary");
    expect(compactionBlocks[0].extra?.state).toBe("compacted");
    expect(compactionBlocks[1].extra?.state).toBe("compacted");
    // A later compaction stays chronological: the intervening turn remains
    // between the two compaction boundaries.
    const types = blocks.map((b) => b.type);
    const firstCompIdx = types.indexOf("compaction");
    const secondCompIdx = types.lastIndexOf("compaction");
    const textIdx = types.indexOf("text");
    expect(firstCompIdx).toBeLessThan(textIdx);
    expect(textIdx).toBeLessThan(secondCompIdx);
  });
});
