/**
 * The `error` stream event.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { makeStream, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"

beforeEach(resetAsyncStore)

// ── _handleSSEEvent: error ────────────────────────────────────────────────────

describe("_handleSSEEvent: error", () => {
  it("sets error message on the store", () => {
    useAgentStore.getState()._handleSSEEvent("error", { message: "Something went wrong" })
    expect(useAgentStore.getState().error).toBe("Something went wrong")
  })

  it("sets isAgentWorking to false", () => {
    useAgentStore.setState({ isAgentWorking: true })
    useAgentStore.getState()._handleSSEEvent("error", { message: "fail" })
    expect(useAgentStore.getState().isAgentWorking).toBe(false)
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
