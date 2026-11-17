/**
 * The `error` stream event.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { makeStream, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"
import { runOf, isRunLive } from '@/stores/useAgentStore/run-state'

beforeEach(resetAsyncStore)

// ── _handleSSEEvent: error ────────────────────────────────────────────────────

describe("_handleSSEEvent: error", () => {
  it("sets error message on the store", () => {
    useAgentStore.getState()._handleSSEEvent("error", { message: "Something went wrong" })
    expect(useAgentStore.getState().error).toBe("Something went wrong")
  })

  it("sets isAgentWorking to false", () => {
    useAgentStore.setState({ sessionRun: runOf(true) })
    useAgentStore.getState()._handleSSEEvent("error", { message: "fail" })
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(false)
  })

  it("does not affect agentStreams", () => {
    useAgentStore.setState({
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    useAgentStore.getState()._handleSSEEvent("error", { message: "fail" })
    // agentStreams untouched by error event
    expect(useAgentStore.getState().agentStreams["lead"].status).toBe("working")
  })
})

describe("_handleSSEEvent: agent_status waiting_lead", () => {
  it("a member session waiting on its lead reads waiting_lead, not working", () => {
    useAgentStore.setState({ leadName: "scout", sessionRun: runOf(true), agentStreams: { scout: makeStream({ status: "working" as const }) } })
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "scout", status: "waiting_lead" })
    expect(useAgentStore.getState().agentStreams["scout"].status).toBe("waiting_lead")
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(false)
  })

  it("in the lead's session, a member waiting on the lead leaves the lead working", () => {
    useAgentStore.setState({ leadName: "lead", sessionRun: runOf(true), agentStreams: { lead: makeStream({ status: "working" as const }) } })
    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "scout", status: "waiting_lead" })
    expect(useAgentStore.getState().agentStreams["scout"].status).toBe("waiting_lead")
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)
  })
})
