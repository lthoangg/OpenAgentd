/**
 * Session-stream events no other suite sends: what each one leaves in the
 * store, read through the store's own `_handleSSEEvent`.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { useAgentStore } from "@/stores/useAgentStore"
import { runOf, isRunLive } from '@/stores/useAgentStore/run-state'

beforeEach(() => {
  useAgentStore.setState({
    agentStreams: {},
    leadName: null,
    agentNames: [],
    sessionId: "sid-1",
    sessionRun: runOf(true),
    error: null,
    setupRequired: null,
    sessionInteractionMode: "code",
    sessionPendingInteractionMode: "plan",
    cacheInvalidations: [],
  })
})

describe("interaction_mode", () => {
  it("adopts a queued switch once it lands and clears the pending marker", () => {
    useAgentStore.getState()._handleSSEEvent("interaction_mode", { interaction_mode: "plan" })
    const s = useAgentStore.getState()
    expect(s.sessionInteractionMode).toBe("plan")
    expect(s.sessionPendingInteractionMode).toBeNull()
  })

  it("ignores a mode it does not know", () => {
    useAgentStore.getState()._handleSSEEvent("interaction_mode", { interaction_mode: "review" })
    const s = useAgentStore.getState()
    expect(s.sessionInteractionMode).toBe("code")
    expect(s.sessionPendingInteractionMode).toBe("plan")
  })
})

describe("agent_not_configured", () => {
  it("fails the agent, stops work, and asks for setup", () => {
    useAgentStore.getState()._handleSSEEvent("agent_not_configured", {
      agent: "lead",
      message: "No model is set",
      action: { type: "open_settings", tab: "models" },
    })
    const s = useAgentStore.getState()
    expect(s.agentStreams.lead.status).toBe("error")
    expect(s.agentStreams.lead.lastError).toBe("No model is set")
    expect(s.agentNames).toEqual(["lead"])
    expect(isRunLive(s.sessionRun)).toBe(false)
    expect(s.setupRequired).toEqual({
      agent: "lead",
      message: "No model is set",
      action: { type: "open_settings", tab: "models" },
    })
  })

  it("asks for setup with no action when the event names none", () => {
    useAgentStore.getState()._handleSSEEvent("agent_not_configured", { agent: "lead", message: "No model" })
    expect(useAgentStore.getState().setupRequired?.action).toEqual({})
  })
})

describe("subagent_spawned and subagent_status", () => {
  it("refreshes the subagents of the lead session the event names", () => {
    useAgentStore.getState()._handleSSEEvent("subagent_spawned", { lead_session_id: "lead-9" })
    useAgentStore.getState()._handleSSEEvent("subagent_status", { lead_session_id: "lead-9" })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "subagents", sessionId: "lead-9" },
      { kind: "subagents", sessionId: "lead-9" },
    ])
  })

  it("falls back to the open session", () => {
    useAgentStore.getState()._handleSSEEvent("subagent_status", {})
    expect(useAgentStore.getState().cacheInvalidations).toEqual([{ kind: "subagents", sessionId: "sid-1" }])
  })

  it("does nothing with no session to refresh", () => {
    useAgentStore.setState({ sessionId: null })
    useAgentStore.getState()._handleSSEEvent("subagent_spawned", {})
    expect(useAgentStore.getState().cacheInvalidations).toEqual([])
  })
})
