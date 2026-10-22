import { afterEach, describe, expect, it, mock } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, isLoadingHistory: false })
})

function renderTranscript(blocks: ContentBlock[] = []) {
  return render(
    <AgentView
      blocks={blocks}
      currentBlocks={[]}
      isWorking={false}
      emptyState={<p>Start something new</p>}
    />,
  )
}

describe("AgentView — opening a saved session", () => {
  it("shows a loading transcript, not the empty state, while its history is on the way", () => {
    useAgentStore.setState({ sessionId: "s1", isLoadingHistory: true })
    renderTranscript()

    const loading = screen.getByRole("status", { name: "Loading conversation" })
    expect(loading.getAttribute("aria-busy")).toBe("true")
    expect(screen.queryByText("Start something new")).toBeNull()
  })

  it("shows the empty state once an empty session's history has loaded", () => {
    useAgentStore.setState({ sessionId: "s1", isLoadingHistory: false })
    renderTranscript()

    expect(screen.getByText("Start something new")).toBeTruthy()
    expect(screen.queryByRole("status", { name: "Loading conversation" })).toBeNull()
  })

  it("shows content that is already here instead of the placeholder", () => {
    useAgentStore.setState({ sessionId: "s1", isLoadingHistory: true })
    renderTranscript([{ id: "u1", type: "user", content: "Hello" }])

    expect(screen.getByText("Hello")).toBeTruthy()
    expect(screen.queryByRole("status", { name: "Loading conversation" })).toBeNull()
  })
})
