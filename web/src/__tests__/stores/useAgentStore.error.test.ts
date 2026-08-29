import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Toast } from "@/stores/useToastStore";
import { inferErrorTitle, useAgentStore } from "@/stores/useAgentStore";
import { useToastStore } from "@/stores/useToastStore";

const INITIAL_TEAM_STATE = {
  agentStreams: {},
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sidebarOpen: false,
  sessionId: null,
  sessionTitle: null,
  isAgentWorking: false,
  isConnected: false,
  error: null,
  _pendingMessages: [],
  _abortController: null,
  _reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  _sessionGeneration: 0,
  cacheInvalidations: [],
};

const realPush = useToastStore.getState().push;
const realDismiss = useToastStore.getState().dismiss;

beforeEach(() => {
  useAgentStore.setState(INITIAL_TEAM_STATE);
  useToastStore.setState({ toasts: [], push: realPush, dismiss: realDismiss });
});

afterEach(() => {
  // Wipe any toasts added by the subscriber during the test so they don't
  // leak into subsequent test files that also check useToastStore.
  useToastStore.setState({ toasts: [], push: realPush, dismiss: realDismiss });
});

function makeStream(status: "idle" | "working" | "error") {
  return {
    blocks: [],
    currentBlocks: [],
    status,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null,
    lastError: null,
    currentText: "",
    currentThinking: "",
  };
}

describe("_handleSSEEvent: done", () => {
  it("preserves error status", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream("error"),
      },
    });

    useAgentStore.getState()._handleSSEEvent("done", {});

    expect(useAgentStore.getState().agentStreams.lead.status).toBe("error");
  });

  it("resets working streams to idle", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream("working"),
      },
    });

    useAgentStore.getState()._handleSSEEvent("done", {});

    expect(useAgentStore.getState().agentStreams.lead.status).toBe("idle");
  });

  it("keeps idle streams idle", () => {
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream("idle"),
      },
    });

    useAgentStore.getState()._handleSSEEvent("done", {});

    expect(useAgentStore.getState().agentStreams.lead.status).toBe("idle");
  });
});

describe("team error toast subscriber", () => {
  function makePush() {
    // mock() only accepts AnyFunction; cast to the typed signature for setState
    return mock(() => undefined) as unknown as (t: Omit<Toast, "id">, durationMs?: number) => void;
  }

  it("pushes an error toast when error changes from null to a string", () => {
    const push = makePush();
    useToastStore.setState({ ...useToastStore.getState(), push });

    useAgentStore.setState({ error: null });
    useAgentStore.setState({ error: "boom" });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      tone: "error",
      title: "Agent error",
      description: "boom",
    });
  });

  it("does not push a toast when the same error is set twice", () => {
    const push = makePush();
    useToastStore.setState({ ...useToastStore.getState(), push });

    useAgentStore.setState({ error: null });
    useAgentStore.setState({ error: "boom" });
    useAgentStore.setState({ error: "boom" });

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not push a toast when error is cleared", () => {
    const push = makePush();
    useToastStore.setState({ ...useToastStore.getState(), push });

    useAgentStore.setState({ error: null });
    useAgentStore.setState({ error: "boom" });
    useAgentStore.setState({ error: null });

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("pushes structured error toast with custom title for non-provider errors", () => {
    const push = makePush();
    useToastStore.setState({ ...useToastStore.getState(), push });

    useAgentStore.setState({ error: null });
    useAgentStore.setState({
      error: {
        title: "Tool Execution Failed",
        message: "Command execution timed out after 60s",
        category: "tool",
        code: "tool_execution_failed",
      },
    });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      tone: "error",
      title: "Tool Execution Failed",
      description: "Command execution timed out after 60s",
    });
  });

  it("skips floating toasts for provider errors so they stay in-transcript", () => {
    const push = makePush();
    useToastStore.setState({ ...useToastStore.getState(), push });

    useAgentStore.setState({ error: null });
    useAgentStore.setState({
      error: {
        title: "Rate Limit Exceeded",
        message: "429 Too Many Requests from Anthropic API",
        category: "provider",
        code: "provider_rate_limit",
      },
    });

    expect(push).not.toHaveBeenCalled();
  });

  it("infers intelligent toast titles for action and stream failures", () => {
    const push = makePush();
    useToastStore.setState({ ...useToastStore.getState(), push });

    useAgentStore.setState({ error: null });
    useAgentStore.setState({ error: "Cannot undo while agents are working — /stop first" });

    expect(push).toHaveBeenCalledWith({
      tone: "error",
      title: "Undo failed",
      description: "Cannot undo while agents are working — /stop first",
    });
  });
});

describe("inferErrorTitle", () => {
  it("uses explicit category titles", () => {
    expect(inferErrorTitle("something", "provider")).toBe("Provider error");
    expect(inferErrorTitle("something", "network")).toBe("Network error");
    expect(inferErrorTitle("something", "tool")).toBe("Tool error");
    expect(inferErrorTitle("something", "user_action")).toBe("Action failed");
    expect(inferErrorTitle("something", "sandbox")).toBe("Permission denied");
  });

  it("infers title from message contents", () => {
    expect(inferErrorTitle("Rate limit hit")).toBe("Rate limit exceeded");
    expect(inferErrorTitle("Invalid API key provided")).toBe("Provider authentication failed");
    expect(inferErrorTitle("Failed to fetch stream")).toBe("Provider connection failed");
    expect(inferErrorTitle("Cannot undo while working")).toBe("Undo failed");
    expect(inferErrorTitle("Failed to compact session")).toBe("Compaction failed");
  });
});

describe("_handleSSEEvent structured error handling", () => {
  it("parses structured error events into store state", () => {
    useAgentStore.setState({ error: null, isAgentWorking: true });

    useAgentStore.getState()._handleSSEEvent("error", {
      title: "Provider Connection Failed",
      message: "anthropic connection timed out",
      category: "network",
      code: "provider_connection_failed",
    });

    const err = useAgentStore.getState().error;
    expect(typeof err).toBe("object");
    expect(err).toEqual({
      title: "Provider Connection Failed",
      message: "anthropic connection timed out",
      category: "network",
      code: "provider_connection_failed",
      agent: undefined,
    });
    expect(useAgentStore.getState().isAgentWorking).toBe(false);
  });

  it("surfaces agent_status error into store error state when not set", () => {
    useAgentStore.setState({ error: null });

    useAgentStore.getState()._handleSSEEvent("agent_status", {
      agent: "executor#1",
      status: "error",
      metadata: {
        title: "Tool Execution Failed",
        message: "Shell command timed out after 60s",
        category: "tool",
        code: "tool_execution_failed",
      },
    });

    const err = useAgentStore.getState().error;
    expect(typeof err).toBe("object");
    expect(err).toEqual({
      title: "Tool Execution Failed",
      message: "Shell command timed out after 60s",
      category: "tool",
      code: "tool_execution_failed",
      agent: "executor#1",
    });
  });

  it("appends provider error blocks directly to blocks and preserves them", () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: {
        lead: {
          blocks: [],
          currentBlocks: [],
          status: "working",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
          model: null,
          lastError: null,
          currentText: "",
          currentThinking: "",
        },
      },
    });

    useAgentStore.getState()._handleSSEEvent("error", {
      title: "Rate Limit Exceeded",
      message: "429 Too Many Requests",
      category: "provider",
      code: "provider_rate_limit",
    });

    const leadStream = useAgentStore.getState().agentStreams["lead"];
    expect(leadStream.blocks.length).toBe(1);
    expect(leadStream.blocks[0].type).toBe("provider_status");
    expect(leadStream.blocks[0].extra?.title).toBe("Rate Limit Exceeded");

    // Firing done or clearing currentBlocks does not erase the committed error block
    useAgentStore.getState()._handleSSEEvent("done", {});
    expect(useAgentStore.getState().agentStreams["lead"].blocks.length).toBe(1);
  });
});
