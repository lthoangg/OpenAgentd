import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { act, cleanup, render, screen } from "@testing-library/react"
import { AgentView } from "@/components/AgentView"
import { _resetSessionSwitchHoldForTests, SWITCH_HOLD_MS } from "@/components/AgentView/useSessionSwitchHold"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

const A: ContentBlock[] = [{ id: "a1", type: "user", content: "Question in A" }]
const B: ContentBlock[] = [{ id: "b1", type: "user", content: "Question in B" }]

beforeEach(() => {
  _resetSessionSwitchHoldForTests()
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, isLoadingHistory: false })
})

function view(blocks: ContentBlock[]) {
  return <AgentView blocks={blocks} currentBlocks={[]} isWorking={false} emptyState={<p>Start something new</p>} />
}

/** Session A on screen, then a switch to `next` whose history is still loading. */
function switchFromA(next: string) {
  useAgentStore.setState({ sessionId: "a", isLoadingHistory: false })
  const utils = render(view(A))
  act(() => {
    useAgentStore.setState({ sessionId: next, isLoadingHistory: true })
    utils.rerender(view([]))
  })
  return utils
}

const hold = (container: HTMLElement) => container.querySelector("[data-session-hold]")

describe("AgentView — switching sessions", () => {
  it("keeps the session being left on screen, inert, while the next one loads", () => {
    const { container } = switchFromA("b")

    expect(screen.getByText("Question in A")).toBeTruthy()
    expect(screen.queryByRole("status", { name: "Loading conversation" })).toBeNull()
    expect(screen.queryByText("Start something new")).toBeNull()
    expect(hold(container)?.getAttribute("data-session-hold")).toBe("outgoing")
    expect(hold(container)?.hasAttribute("inert")).toBe(true)
  })

  it("gives way to the loading transcript after a beat", async () => {
    switchFromA("b")

    await act(() => new Promise((resolve) => setTimeout(resolve, SWITCH_HOLD_MS + 20)))
    expect(screen.queryByText("Question in A")).toBeNull()
    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeTruthy()
  })

  it("swaps straight to the next session when its history lands", () => {
    const { container, rerender } = switchFromA("b")

    act(() => {
      useAgentStore.setState({ isLoadingHistory: false })
      rerender(view(B))
    })
    expect(screen.getByText("Question in B")).toBeTruthy()
    expect(screen.queryByText("Question in A")).toBeNull()
    expect(hold(container)).toBeNull()
  })

  it("shows a recently viewed session's last transcript until its history lands", () => {
    useAgentStore.setState({ sessionId: "b", isLoadingHistory: false })
    const { container, rerender } = render(view(B))
    act(() => {
      useAgentStore.setState({ sessionId: "a", isLoadingHistory: false })
      rerender(view(A))
    })

    act(() => {
      useAgentStore.setState({ sessionId: "b", isLoadingHistory: true })
      rerender(view([]))
    })
    expect(screen.getByText("Question in B")).toBeTruthy()
    expect(screen.queryByText("Question in A")).toBeNull()
    expect(hold(container)?.getAttribute("data-session-hold")).toBe("recent")
  })

  it("does not hold anything for a new chat", () => {
    useAgentStore.setState({ sessionId: "a", isLoadingHistory: false })
    const { rerender } = render(view(A))
    act(() => {
      useAgentStore.setState({ sessionId: null, isLoadingHistory: false })
      rerender(view([]))
    })

    expect(screen.queryByText("Question in A")).toBeNull()
    expect(screen.getByText("Start something new")).toBeTruthy()
  })
})
