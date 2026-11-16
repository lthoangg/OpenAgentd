/**
 * The sidebar toggle.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"

beforeEach(resetAsyncStore)

// ── toggleSidebar ─────────────────────────────────────────────────────────────

describe("toggleSidebar", () => {
  it("toggles sidebarOpen from false to true", () => {
    useAgentStore.setState({ sidebarOpen: false })
    useAgentStore.getState().toggleSidebar()
    expect(useAgentStore.getState().sidebarOpen).toBe(true)
  })

  it("toggles sidebarOpen from true to false", () => {
    useAgentStore.setState({ sidebarOpen: true })
    useAgentStore.getState().toggleSidebar()
    expect(useAgentStore.getState().sidebarOpen).toBe(false)
  })

  it("can toggle multiple times", () => {
    useAgentStore.setState({ sidebarOpen: false })
    useAgentStore.getState().toggleSidebar()
    useAgentStore.getState().toggleSidebar()
    useAgentStore.getState().toggleSidebar()
    expect(useAgentStore.getState().sidebarOpen).toBe(true)
  })
})
