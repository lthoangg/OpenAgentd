import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

beforeEach(() => {
  useAgentStore.setState({ sessionId: "test-session-123" })
})

afterEach(cleanup)

const request: ContentBlock = {
  id: "req-1",
  type: "user",
  content: "Create the orders queue.",
  extra: { sent_from: { session_id: "app-session", workspace: "/r/app", workspace_name: "app", session_title: "Orders service", reply: true, hops: 1 } },
  timestamp: new Date(),
}

const reply = (status: string): ContentBlock => ({
  id: `reply-${status}`,
  type: "user",
  content: "Queue URL is sqs://orders.",
  extra: { from_agent: "infra", reply_from: { session_id: "infra-session", workspace: "/r/infra", workspace_name: "infra", status } },
  timestamp: new Date(),
})

describe("AgentView — workspace messages", () => {
  it("shows where a prompt came from and opens the sending session", async () => {
    const onOpenSession = mock(() => {})
    render(<AgentView blocks={[request]} currentBlocks={[]} isWorking={false} onOpenSession={onOpenSession} />)

    expect(screen.getByText("Create the orders queue.")).toBeTruthy()
    const chip = screen.getByRole("button", { name: "Open the sending session in app" })
    expect(chip).toHaveTextContent("From")
    expect(chip).toHaveTextContent("· Orders service")
    expect(chip.className).toContain("pointer-coarse:min-h-9")
    await userEvent.setup().click(chip)
    expect(onOpenSession).toHaveBeenCalledWith("app-session", "/r/app")
    // It is a prompt, not a report: it stays editable.
    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy()
  })

  it("renders the chip as plain text without a navigation handler", () => {
    const { container } = render(<AgentView blocks={[request]} currentBlocks={[]} isWorking={false} />)
    expect(screen.queryByRole("button", { name: /Open the sending session/ })).toBeNull()
    expect(container.querySelector("span[data-sent-from]")).toBeTruthy()
  })

  it("labels a reply and links to the replying session", async () => {
    const onOpenSession = mock(() => {})
    render(<AgentView blocks={[reply("completed")]} currentBlocks={[]} isWorking={false} onOpenSession={onOpenSession} />)

    expect(screen.getByText("Workspace reply")).toBeTruthy()
    expect(screen.queryByText("Subagent report")).toBeNull()
    await userEvent.setup().click(screen.getByRole("button", { name: "Open the replying session in infra" }))
    expect(onOpenSession).toHaveBeenCalledWith("infra-session", "/r/infra")
  })

  it("marks a failure notice", () => {
    render(<AgentView blocks={[reply("error")]} currentBlocks={[]} isWorking={false} />)
    expect(screen.getByText("Workspace update · failed")).toBeTruthy()
    expect(screen.getByText("infra")).toBeTruthy()
  })
})
