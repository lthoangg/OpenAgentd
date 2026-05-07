import { beforeEach, describe, expect, it, mock } from "bun:test";
import { useTeamStore } from "@/stores/useTeamStore";
import { useToastStore } from "@/stores/useToastStore";

const INITIAL_TEAM_STATE = {
  agentStreams: {},
  activeAgent: null,
  leadName: null,
  agentNames: [],
  sidebarOpen: false,
  sessionId: null,
  sessionTitle: null,
  isTeamWorking: false,
  isConnected: false,
  error: null,
  _pendingMessages: [],
  _abortController: null,
  _sessionGeneration: 0,
  cacheInvalidations: [],
};

beforeEach(() => {
  useTeamStore.setState(INITIAL_TEAM_STATE);
  useToastStore.setState({ toasts: [], push: useToastStore.getState().push, dismiss: useToastStore.getState().dismiss });
});

function makeStream(status: "available" | "working" | "error") {
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

  it("resets working streams to available", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream("working"),
      },
    });

    useTeamStore.getState()._handleSSEEvent("done", {});

    expect(useTeamStore.getState().agentStreams.lead.status).toBe("available");
  });

  it("keeps available streams available", () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream("available"),
      },
    });

    useTeamStore.getState()._handleSSEEvent("done", {});

    expect(useTeamStore.getState().agentStreams.lead.status).toBe("available");
  });
});

describe("team error toast subscriber", () => {
  it("pushes an error toast when error changes from null to a string", () => {
    const push = mock(useToastStore.getState().push);
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
    const push = mock(useToastStore.getState().push);
    useToastStore.setState({ ...useToastStore.getState(), push });

    useTeamStore.setState({ error: null });
    useTeamStore.setState({ error: "boom" });
    useTeamStore.setState({ error: "boom" });

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not push a toast when error is cleared", () => {
    const push = mock(useToastStore.getState().push);
    useToastStore.setState({ ...useToastStore.getState(), push });

    useTeamStore.setState({ error: null });
    useTeamStore.setState({ error: "boom" });
    useTeamStore.setState({ error: null });

    expect(push).toHaveBeenCalledTimes(1);
  });
});
