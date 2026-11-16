/**
 * Tool events from the stream.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { mockSendDesktopNotification, makeStream, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"

beforeEach(resetAsyncStore)

describe("tool_end: notifications", () => {
  it("does not notify when a background process completes through bg", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    useAgentStore.getState()._handleSSEEvent("tool_end", {
      agent: "lead",
      name: "bg",
      result: "PID 123: exited (code 0)\nFinal output:\nok",
    })

    expect(mockSendDesktopNotification).not.toHaveBeenCalled()
  })
})
