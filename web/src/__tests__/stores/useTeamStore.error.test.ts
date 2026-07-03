import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Toast } from "@/stores/useToastStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { useToastStore } from "@/stores/useToastStore";

const INITIAL_TEAM_STATE = {
  agentStreams: {},
  activeAgent: null,
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sidebarOpen: false,
  sessionId: null,
  sessionTitle: null,
  isTeamWorking: false,
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
  useTeamStore.setState(INITIAL_TEAM_STATE);
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
    _completionBase: 0,
  };
}

describe("_handleSSEEvent: done", () => {
  it("preserves error status", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream("error"),
      },
    });

    useTeamStore.getState()._handleSSEEvent("done", {});

    expect(useTeamStore.getState().agentStreams.lead.status).toBe("error");
  });

  it("resets working streams to idle", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream("working"),
      },
    });

    useTeamStore.getState()._handleSSEEvent("done", {});

    expect(useTeamStore.getState().agentStreams.lead.status).toBe("idle");
  });

  it("keeps idle streams idle", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream("idle"),
      },
    });

    useTeamStore.getState()._handleSSEEvent("done", {});

    expect(useTeamStore.getState().agentStreams.lead.status).toBe("idle");
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

    useTeamStore.setState({ error: null });
    useTeamStore.setState({ error: "boom" });

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

    useTeamStore.setState({ error: null });
    useTeamStore.setState({ error: "boom" });
    useTeamStore.setState({ error: "boom" });

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not push a toast when error is cleared", () => {
    const push = makePush();
    useToastStore.setState({ ...useToastStore.getState(), push });

    useTeamStore.setState({ error: null });
    useTeamStore.setState({ error: "boom" });
    useTeamStore.setState({ error: null });

    expect(push).toHaveBeenCalledTimes(1);
  });
});
