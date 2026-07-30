import { describe, it, expect, beforeEach } from "bun:test";
import { useTeamStore } from "@/stores/useTeamStore";
import type { ContentBlock } from "@/api/types";

// Me reset store before each test
const INITIAL = {
  agentStreams: {},
  activeAgent: null,
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sidebarOpen: false,
  sessionId: null,
  isTeamWorking: false,
  isContinuing: false,
  isConnected: false,
  error: null,
  _pendingMessages: [] as import('@/stores/useTeamStore').PendingMessage[],
  _sessionGeneration: 0,
  cacheInvalidations: [],
  _abortController: null,
  _reconnectTimer: null as ReturnType<typeof setTimeout> | null,
};

beforeEach(() => {
  useTeamStore.setState(INITIAL);
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
    _completionBase: 0,
    ...overrides,
  };
}

// ── newSession ────────────────────────────────────────────────────────────────

describe("newSession", () => {
  it("clears sessionId and resets working state", () => {
    useTeamStore.setState({ sessionId: "old-sid", isTeamWorking: true });
    useTeamStore.getState().newSession();
    const s = useTeamStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.isTeamWorking).toBe(false);
  });

  it("resets agent blocks and returns the live roster to the lead", () => {
    useTeamStore.setState({
      leadName: "lead",
      agentNames: ["lead", "worker"],
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "b1", type: "text" as const, content: "old" }] }),
        worker: makeStream({ status: "working" }),
      },
      activeAgent: "worker",
    });
    useTeamStore.getState().newSession();
    const s = useTeamStore.getState();
    expect(s.agentNames).toEqual(["lead"]);
    expect(s.activeAgent).toBe("lead");
    expect(s.agentStreams.lead.blocks).toHaveLength(0);
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(0);
    expect(s.agentStreams.worker).toBeUndefined();
  });

  it("bumps _sessionGeneration", () => {
    const before = useTeamStore.getState()._sessionGeneration;
    useTeamStore.getState().newSession();
    expect(useTeamStore.getState()._sessionGeneration).toBe(before + 1);
  });

  it("aborts the active stream when starting a new session", () => {
    const abort = new AbortController();
    useTeamStore.setState({
      sessionId: "streaming-session",
      isConnected: true,
      _abortController: abort,
    });

    useTeamStore.getState().newSession();

    const s = useTeamStore.getState();
    expect(abort.signal.aborted).toBe(true);
    expect(s._abortController).toBeNull();
    expect(s.isConnected).toBe(false);
  });
});

// ── beginResolvedSession ────────────────────────────────────────────────────

describe("beginResolvedSession", () => {
  it("sets the persisted session id and model settings", () => {
    useTeamStore.setState({
      sessionId: "old-sid",
      sessionModel: "old:model",
      sessionThinkingLevel: "low",
      isConnected: true,
    });

    useTeamStore.getState().beginResolvedSession("new-sid", {
      mode: "normal",
      model: "openai:gpt-5.5",
      thinkingLevel: "high",
    });

    const s = useTeamStore.getState();
    expect(s.sessionId).toBe("new-sid");
    expect(s.sessionModel).toBe("openai:gpt-5.5");
    expect(s.sessionThinkingLevel).toBe("high");
    expect(s.isConnected).toBe(false);
  });

  it("drops the previous session's live stream when switching to another session", () => {
    const abort = new AbortController();
    useTeamStore.setState({
      sessionId: "session-a",
      sessionTitle: "Session A",
      leadName: "lead",
      agentNames: ["lead"],
      activeAgent: "lead",
      isTeamWorking: true,
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

    useTeamStore.getState().beginResolvedSession("session-b", { mode: "normal" });

    const s = useTeamStore.getState();
    expect(s.sessionId).toBe("session-b");
    expect(s.isTeamWorking).toBe(false);
    expect(s.sessionTitle).toBeNull();
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(0);
    expect(s.agentStreams.lead.currentText).toBe("");
    expect(s.agentStreams.lead.status).toBe("idle");
    expect(abort.signal.aborted).toBe(true);
  });

  it("keeps in-flight state when the resolved id matches the active session", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentNames: ["lead"],
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentBlocks: [{ id: "b1", type: "text" as const, content: "streaming in A" }],
        }),
      },
    });

    useTeamStore.getState().beginResolvedSession("session-a", { mode: "normal" });

    const s = useTeamStore.getState();
    expect(s.isTeamWorking).toBe(true);
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(1);
  });

  it("stores coding workspace and resets streams to the lead", () => {
    useTeamStore.setState({
      leadName: "lead",
      agentNames: ["lead", "worker"],
      activeAgent: "worker",
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "b1", type: "text" as const, content: "old" }] }),
        worker: makeStream({ status: "working" }),
      },
    });

    useTeamStore.getState().beginResolvedSession("coding-sid", {
      mode: "coding",
      workspace: "/repo/app",
    });

    const s = useTeamStore.getState();
    expect(s.sessionId).toBe("coding-sid");
    expect(s._workspace).toBe("/repo/app");
    expect(s.agentNames).toEqual(["lead"]);
    expect(s.activeAgent).toBe("lead");
    expect(s.agentStreams.lead.blocks).toHaveLength(0);
    expect(s.agentStreams.worker).toBeUndefined();
  });
});

// ── isEmptyIdleSession ───────────────────────────────────────────────────────

describe("isEmptyIdleSession", () => {
  it("returns true for a persisted idle session with no visible blocks", () => {
    useTeamStore.setState({
      sessionId: "empty-sid",
      isTeamWorking: false,
      agentNames: ["lead", "worker"],
      agentStreams: {
        lead: makeStream(),
        worker: makeStream(),
      },
    });

    expect(useTeamStore.getState().isEmptyIdleSession()).toBe(true);
  });

  it("ignores compaction markers when checking visible blocks", () => {
    useTeamStore.setState({
      sessionId: "empty-sid",
      isTeamWorking: false,
      agentNames: ["lead"],
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "c1", type: "compaction" as const, content: "summary" }] }),
      },
    });

    expect(useTeamStore.getState().isEmptyIdleSession()).toBe(true);
  });

  it("returns false when the session has a visible message", () => {
    useTeamStore.setState({
      sessionId: "active-sid",
      isTeamWorking: false,
      agentNames: ["lead"],
      agentStreams: {
        lead: makeStream({ blocks: [{ id: "u1", type: "user" as const, content: "hello" }] }),
      },
    });

    expect(useTeamStore.getState().isEmptyIdleSession()).toBe(false);
  });
});

// ── setActiveAgent ────────────────────────────────────────────────────────────

describe("setActiveAgent", () => {
  it("updates activeAgent", () => {
    useTeamStore.getState().setActiveAgent("researcher");
    expect(useTeamStore.getState().activeAgent).toBe("researcher");
  });
});

// ── _handleSSEEvent: message ──────────────────────────────────────────────────

describe("_handleSSEEvent: message", () => {
  it("appends text to agent currentBlocks", () => {
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "hello" });
    const stream = useTeamStore.getState().agentStreams["lead"];
    expect(stream).toBeDefined();
    expect(stream.currentBlocks).toHaveLength(1);
    expect(stream.currentBlocks[0].content).toBe("hello");
  });

  it("appends to same text block on subsequent chunks", () => {
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "hello" });
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: " world" });
    const stream = useTeamStore.getState().agentStreams["lead"];
    expect(stream.currentBlocks).toHaveLength(1);
    expect(stream.currentBlocks[0].content).toBe("hello world");
  });

  it("isolates chunks per agent", () => {
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "lead says" });
    useTeamStore.getState()._handleSSEEvent("message", { agent: "worker", text: "worker says" });
    expect(useTeamStore.getState().agentStreams["lead"].currentBlocks[0].content).toBe("lead says");
    expect(useTeamStore.getState().agentStreams["worker"].currentBlocks[0].content).toBe("worker says");
  });

  it("adds newly-spawned agents to agentNames when stream events arrive", () => {
    useTeamStore.setState({ agentNames: ["lead"] });
    useTeamStore.getState()._handleSSEEvent("message", { agent: "executor#1", text: "hi" });
    expect(useTeamStore.getState().agentNames).toEqual(["lead", "executor#1"]);
  });
});

// ── _handleSSEEvent: thinking ─────────────────────────────────────────────────

describe("_handleSSEEvent: thinking", () => {
  it("creates thinking block", () => {
    useTeamStore.getState()._handleSSEEvent("thinking", { agent: "lead", text: "let me think" });
    const stream = useTeamStore.getState().agentStreams["lead"];
    expect(stream.currentBlocks[0].type).toBe("thinking");
    expect(stream.currentBlocks[0].content).toBe("let me think");
  });
});

// ── _handleSSEEvent: tool lifecycle ──────────────────────────────────────────

describe("_handleSSEEvent: tool lifecycle", () => {
  it("tool_call creates pending tool block", () => {
    useTeamStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc1" });
    const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0];
    expect(block.type).toBe("tool");
    expect(block.toolDone).toBe(false);
    expect(block.toolCallId).toBe("tc1");
  });

  it("tool_start fills args", () => {
    useTeamStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc1" });
    useTeamStore.getState()._handleSSEEvent("tool_start", { agent: "lead", name: "web_search", tool_call_id: "tc1", arguments: '{"q":"test"}' });
    const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0];
    expect(block.toolArgs).toBe('{"q":"test"}');
  });

  it("tool_end marks done with result", () => {
    useTeamStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc1" });
    useTeamStore.getState()._handleSSEEvent("tool_start", { agent: "lead", name: "web_search", tool_call_id: "tc1", arguments: "{}" });
    useTeamStore.getState()._handleSSEEvent("tool_end", { agent: "lead", name: "web_search", tool_call_id: "tc1", result: "results" });
    const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0];
    expect(block.toolDone).toBe(true);
    expect(block.toolResult).toBe("results");
  });

  // A mid-turn loadSession can reconcile a still-executing tool card into the
  // confirmed `blocks` (the assistant row with tool_calls persists before the
  // tool finishes). Later live events must reach that card instead of
  // vanishing — otherwise it renders as "running" forever until a reload.
  describe("events for a card already reconciled into confirmed blocks", () => {
    const seedConfirmedRunningTool = () => {
      useTeamStore.setState({
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
      useTeamStore.getState()._handleSSEEvent("tool_end", { agent: "lead", name: "shell", tool_call_id: "tc-1", result: "ok" });
      const stream = useTeamStore.getState().agentStreams.lead;
      expect(stream.blocks[0].toolDone).toBe(true);
      expect(stream.blocks[0].toolResult).toBe("ok");
      expect(stream.currentBlocks).toHaveLength(0);
    });

    it("tool_output_delta streams onto the confirmed card", () => {
      seedConfirmedRunningTool();
      useTeamStore.getState()._handleSSEEvent("tool_output_delta", { agent: "lead", name: "shell", tool_call_id: "tc-1", text: "file.txt\n" });
      const stream = useTeamStore.getState().agentStreams.lead;
      expect(stream.blocks[0].toolOutput).toBe("file.txt\n");
      expect(stream.currentBlocks).toHaveLength(0);
    });

    it("replayed tool_call / tool_start do not spawn a duplicate live card", () => {
      seedConfirmedRunningTool();
      useTeamStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-1" });
      useTeamStore.getState()._handleSSEEvent("tool_start", { agent: "lead", name: "shell", tool_call_id: "tc-1", arguments: '{"command":"ls"}' });
      expect(useTeamStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0);
    });

    it("tool_end without an id match in blocks still uses the live name fallback", () => {
      // Regression guard: the blocks fall-through must not complete orphaned
      // incomplete cards in history by name.
      seedConfirmedRunningTool();
      useTeamStore.getState()._handleSSEEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "tc-2" });
      useTeamStore.getState()._handleSSEEvent("tool_end", { agent: "lead", name: "shell", tool_call_id: "tc-2", result: "second" });
      const stream = useTeamStore.getState().agentStreams.lead;
      expect(stream.blocks[0].toolDone).toBe(false);
      expect(stream.currentBlocks[0].toolDone).toBe(true);
      expect(stream.currentBlocks[0].toolResult).toBe("second");
    });
  });

  it("team_manage tool_end invalidates the team agents cache", () => {
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      agent: "lead",
      name: "team_manage",
      tool_call_id: "tc1",
      result: "Spawned: executor#1.",
    });
    expect(useTeamStore.getState().cacheInvalidations).toEqual([
      { kind: "team_agents" },
    ]);
  });
});

// ── _handleSSEEvent: agent_status ────────────────────────────────────────────

describe("_handleSSEEvent: agent_status", () => {
  it("sets agent status to working", () => {
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    expect(useTeamStore.getState().agentStreams["lead"].status).toBe("working");
  });

  it("sets agent status to idle", () => {
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "idle" });
    expect(useTeamStore.getState().agentStreams["lead"].status).toBe("idle");
  });

  it("sets agent status to error with message", () => {
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "error", metadata: { message: "something broke" } });
    expect(useTeamStore.getState().agentStreams["lead"].status).toBe("error");
    expect(useTeamStore.getState().agentStreams["lead"].lastError).toBe("something broke");
  });

  it("sets agent status to offline", () => {
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "offline" });
    expect(useTeamStore.getState().agentStreams["worker"].status).toBe("offline");
  });

  it("keeps isTeamWorking=true while any other agent is still working", () => {
    // Lead + worker both working
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "working" });
    expect(useTeamStore.getState().isTeamWorking).toBe(true);

    // Worker goes idle — lead still working, global flag must stay true
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "idle" });
    const s = useTeamStore.getState();
    expect(s.agentStreams.worker.status).toBe("idle");
    expect(s.agentStreams.lead.status).toBe("working");
    expect(s.isTeamWorking).toBe(true);
  });

  it("clears isTeamWorking when the last working agent goes idle", () => {
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "working" });
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "worker", status: "idle" });
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "idle" });
    expect(useTeamStore.getState().isTeamWorking).toBe(false);
  });

  it("clears isTeamWorking when the last working agent errors out", () => {
    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" });
    useTeamStore.getState()._handleSSEEvent("agent_status", {
      agent: "lead",
      status: "error",
      metadata: { message: "boom" },
    });
    expect(useTeamStore.getState().isTeamWorking).toBe(false);
  });
});

// ── _handleSSEEvent: done ─────────────────────────────────────────────────────

describe("_handleSSEEvent: done", () => {
  it("flushes currentBlocks into blocks and clears working flag", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          currentBlocks: [{ id: "b1", type: "text" as const, content: "response" }],
          status: "working" as const,
        }),
      },
    });
    useTeamStore.getState()._handleSSEEvent("done", {});
    const s = useTeamStore.getState();
    expect(s.isTeamWorking).toBe(false);
    expect(s.agentStreams.lead.blocks).toHaveLength(1);
    expect(s.agentStreams.lead.currentBlocks).toHaveLength(0);
  });

  it("flushes worker blocks too", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      leadName: "lead",
      agentStreams: {
        worker: makeStream({
          currentBlocks: [{ id: "b1", type: "text" as const, content: "worker output" }],
          status: "working" as const,
        }),
      },
    });
    useTeamStore.getState()._handleSSEEvent("done", {});
    const s = useTeamStore.getState();
    expect(s.agentStreams.worker.blocks).toHaveLength(1);
    expect(s.agentStreams.worker.currentBlocks).toHaveLength(0);
  });

  it("sets all agent statuses to idle", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    });
    useTeamStore.getState()._handleSSEEvent("done", {});
    expect(useTeamStore.getState().agentStreams.lead.status).toBe("idle");
    expect(useTeamStore.getState().agentStreams.worker.status).toBe("idle");
  });

  it("preserves offline status on done", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      leadName: "lead",
      agentStreams: {
        worker: makeStream({ status: "offline" as const }),
      },
    });
    useTeamStore.getState()._handleSSEEvent("done", {});
    expect(useTeamStore.getState().agentStreams.worker.status).toBe("offline");
  });
});

// ── _handleSSEEvent: session ──────────────────────────────────────────────────

describe("_handleSSEEvent: session", () => {
  it("sets sessionId from event data", () => {
    useTeamStore.getState()._handleSSEEvent("session", { session_id: "new-sid" });
    expect(useTeamStore.getState().sessionId).toBe("new-sid");
  });
});

// ── _handleSSEEvent: usage ────────────────────────────────────────────────────

describe("_handleSSEEvent: usage", () => {
  it("reads agent from metadata.agent (backend wire format)", () => {
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cached_tokens: 2,
      metadata: { agent: "lead" },
    });
    const usage = useTeamStore.getState().agentStreams["lead"].usage;
    expect(usage.totalTokens).toBe(15);
    expect(usage.promptTokens).toBe(10);
    expect(usage.cachedTokens).toBe(2);
  });

  it("accumulates estimated cost for the session", () => {
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      estimated_cost_usd: 0.0012,
      metadata: { agent: "lead" },
    });
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      estimated_cost_usd: 0.0023,
      metadata: { agent: "lead" },
    });

    expect(useTeamStore.getState().agentStreams.lead.usage.estimatedCostUsd).toBe(0.0035);
  });

  it("keeps a running session cost across 100 usage events", () => {
    for (let turn = 1; turn <= 100; turn += 1) {
      useTeamStore.getState()._handleSSEEvent("usage", {
        prompt_tokens: turn * 10,
        completion_tokens: 5,
        total_tokens: turn * 10 + 5,
        estimated_cost_usd: 0.0012,
        metadata: { agent: "lead" },
      });
    }

    expect(useTeamStore.getState().agentStreams.lead.usage.estimatedCostUsd).toBe(0.12);
  });

  it("falls back to top-level agent field", () => {
    useTeamStore.getState()._handleSSEEvent("usage", {
      agent: "worker",
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      cached_tokens: 0,
    });
    const usage = useTeamStore.getState().agentStreams["worker"].usage;
    expect(usage.totalTokens).toBe(28);
  });

  it("accumulates usage across multiple events (multi-turn)", () => {
    // Me input = latest turn only, output = sum all turns, cache = latest turn
    // Turn 1: fire usage then done (done commits _completionBase)
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      cached_tokens: 0, metadata: { agent: "lead" },
    });
    useTeamStore.setState((s) => ({
      agentStreams: {
        ...s.agentStreams,
        lead: { ...s.agentStreams.lead, status: "working" as const },
      },
    }));
    useTeamStore.getState()._handleSSEEvent("done", {});
    // Turn 2: fire second usage event — completionBase now = 5
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
      cached_tokens: 3, metadata: { agent: "lead" },
    });
    const usage = useTeamStore.getState().agentStreams["lead"].usage;
    expect(usage.promptTokens).toBe(20);      // latest turn input only
    expect(usage.completionTokens).toBe(15);  // sum: 5 (turn1) + 10 (turn2)
    expect(usage.totalTokens).toBe(35);       // latest input + total output
    expect(usage.cachedTokens).toBe(3);       // latest turn cache only
  });

  it("stores backend turn_total usage without changing displayed current usage", () => {
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      cached_tokens: 10, metadata: { agent: "lead" },
    });
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
      cached_tokens: 15, metadata: { agent: "lead" },
    });
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 220, completion_tokens: 50, total_tokens: 270,
      cached_tokens: 25, metadata: { agent: "lead", turn_total: true },
    });

    const usage = useTeamStore.getState().agentStreams["lead"].usage;
    expect(usage.promptTokens).toBe(120);
    expect(usage.completionTokens).toBe(30);
    expect(usage.totalTokens).toBe(150);
    expect(usage.cachedTokens).toBe(15);
    expect(usage.turnPromptTokens).toBe(220);
    expect(usage.turnCompletionTokens).toBe(50);
    expect(usage.turnTotalTokens).toBe(270);
    expect(usage.turnCachedTokens).toBe(25);
  });

  it("clears stored turn cache count when backend turn_total omits cached_tokens", () => {
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      cached_tokens: 10, metadata: { agent: "lead", turn_total: true },
    });
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
      metadata: { agent: "lead", turn_total: true },
    });

    const usage = useTeamStore.getState().agentStreams["lead"].usage;
    expect(usage.turnCachedTokens).toBe(0);
  });

  it("ignores event with no agent field", () => {
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    });
    // Me no stream created for unknown agent
    expect(Object.keys(useTeamStore.getState().agentStreams)).toHaveLength(0);
  });

  it("resets usage on newSession", () => {
    useTeamStore.getState()._handleSSEEvent("usage", {
      prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      cached_tokens: 5, metadata: { agent: "lead" },
    });
    useTeamStore.getState().newSession();
    expect(useTeamStore.getState().agentStreams["lead"].usage.totalTokens).toBe(0);
  });
});

// ── _handleSSEEvent: summarization ────────────────────────────────────────────

describe("_handleSSEEvent: summarization", () => {
  it("summarization_start appends a compacting block to the agent's finalized blocks", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    const stream = useTeamStore.getState().agentStreams.lead;
    expect(stream.currentBlocks).toHaveLength(0);
    expect(stream.blocks).toHaveLength(1);
    expect(stream.blocks[0].type).toBe("compaction");
    expect(stream.blocks[0].extra?.state).toBe("compacting");
  });

  it("summarization_content streams text onto the trailing compacting block", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "Hello " });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "world." });
    const blocks = useTeamStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].content).toBe("Hello world.");
    expect(blocks[0].extra?.state).toBe("compacting");
  });

  it("summarization_end flips the block to compacted and uses the final summary", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "partial" });
    useTeamStore.getState()._handleSSEEvent("summarization_end", {
      agent: "lead",
      summary: "final summary",
    });
    const blocks = useTeamStore.getState().agentStreams.lead.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].extra?.state).toBe("compacted");
    expect(blocks[0].content).toBe("final summary");
  });

  it("summarization_end with metadata.error sets the error flag", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_end", {
      agent: "lead",
      summary: "",
      metadata: { error: true },
    });
    const blocks = useTeamStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].extra?.state).toBe("compacted");
    expect(blocks[0].extra?.error).toBe(true);
  });

  it("re-emitted summarization_start during replay does not duplicate the block", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "halfway" });
    // Reconnect replay re-emits start — must not append a fresh block.
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    const blocks = useTeamStore.getState().agentStreams.lead.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("halfway");
  });

  it("places auto-triggered compaction after content already streamed in the turn", () => {
    useTeamStore.setState({
      agentStreams: {
        lead: makeStream({
          blocks: [{ id: "old", type: "text" as const, content: "earlier turn" }],
          currentBlocks: [{ id: "pre-trigger", type: "text" as const, content: "streamed before trigger" }],
        }),
      },
      agentNames: ["lead"],
      leadName: "lead",
    });

    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "summary" });
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "streamed after trigger" });

    const stream = useTeamStore.getState().agentStreams.lead;
    expect(stream.blocks.map((block) => block.id)).toEqual(["old", "pre-trigger", expect.stringContaining("block-")]);
    expect(stream.blocks.map((block) => block.type)).toEqual(["text", "text", "compaction"]);
    expect(stream.blocks[2].content).toBe("summary");
    expect(stream.currentBlocks.map((block) => block.content)).toEqual(["streamed after trigger"]);
  });

  it("ignores events with empty agent", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "" });
    expect(useTeamStore.getState().agentStreams).toEqual({});
  });

  // ── full sequence with pre-trigger currentBlocks ─────────────────────────
  // Auto-compaction fires between model iterations, so currentBlocks may
  // already contain output shown earlier in this turn. That output must be
  // sealed before the marker; model output emitted after compaction remains
  // in currentBlocks and therefore renders below it.

  it("full sequence: start→content→end preserves the auto-trigger boundary", () => {
    useTeamStore.setState({
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
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    let stream = useTeamStore.getState().agentStreams.lead;
    expect(stream.blocks.map((b) => b.type)).toEqual(["text", "user", "text", "compaction"]);
    expect(stream.blocks[3].extra?.state).toBe("compacting");
    expect(stream.currentBlocks).toHaveLength(0);

    // content — accumulates on the compacting block; later model output starts
    // a fresh live block after the marker.
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "Sum " });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "mary." });
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "post-compaction" });
    stream = useTeamStore.getState().agentStreams.lead;
    expect(stream.blocks[3].content).toBe("Sum mary.");
    expect(stream.blocks[3].extra?.state).toBe("compacting");
    expect(stream.currentBlocks[0].content).toBe("post-compaction");

    // end — compacting block flips without moving later streaming output.
    useTeamStore.getState()._handleSSEEvent("summarization_end", {
      agent: "lead",
      summary: "Final summary.",
    });
    stream = useTeamStore.getState().agentStreams.lead;
    expect(stream.blocks[3].extra?.state).toBe("compacted");
    expect(stream.blocks[3].content).toBe("Final summary.");
    expect(stream.currentBlocks[0].content).toBe("post-compaction");
  });

  it("done flushes currentBlocks AFTER compaction block — order preserved", () => {
    useTeamStore.setState({
      isTeamWorking: true,
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

    useTeamStore.getState()._handleSSEEvent("done", {});
    const stream = useTeamStore.getState().agentStreams.lead;

    // Order must be: earlier-text → compaction → post-compaction-text
    expect(stream.blocks.map((b) => b.id)).toEqual(["t0", "c1", "t1"]);
    expect(stream.blocks[1].type).toBe("compaction");
    expect(stream.blocks[2].content).toBe("post-compaction response");
    expect(stream.currentBlocks).toHaveLength(0);
  });

  it("summarization_content dropped when text field missing", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    // No text field — guard must drop the event cleanly
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead" });
    const blocks = useTeamStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].content).toBe(""); // unchanged
  });

  it("summarization_end missing summary field defaults to streamed content", () => {
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "streamed" });
    // summary field absent from event
    useTeamStore.getState()._handleSSEEvent("summarization_end", { agent: "lead" });
    const blocks = useTeamStore.getState().agentStreams.lead.blocks;
    expect(blocks[0].extra?.state).toBe("compacted");
    // endCompaction: summary="" falsy → falls back to block.content ("streamed")
    expect(blocks[0].content).toBe("streamed");
  });

  it("second full compaction cycle appends a second block after the first compacted one", () => {
    // First cycle
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "first" });
    useTeamStore.getState()._handleSSEEvent("summarization_end", { agent: "lead", summary: "first summary" });

    // In between: some new streaming content is committed via done
    useTeamStore.setState((s) => ({
      agentStreams: {
        ...s.agentStreams,
        lead: {
          ...s.agentStreams.lead,
          currentBlocks: [{ id: "t1", type: "text" as const, content: "new turn" }],
        },
      },
    }));
    useTeamStore.getState()._handleSSEEvent("done", {});

    // Second cycle
    useTeamStore.getState()._handleSSEEvent("summarization_start", { agent: "lead" });
    useTeamStore.getState()._handleSSEEvent("summarization_content", { agent: "lead", text: "second" });
    useTeamStore.getState()._handleSSEEvent("summarization_end", { agent: "lead", summary: "second summary" });

    const blocks = useTeamStore.getState().agentStreams.lead.blocks;
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
