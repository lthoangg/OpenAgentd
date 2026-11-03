import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import { useDisplayPrefsStore } from "@/stores/useDisplayPrefsStore"
import type { ContentBlock } from "@/api/types"

beforeEach(() => {
  useAgentStore.setState({ sessionId: "test-session-123", parentSessionId: null })
  useDisplayPrefsStore.setState({ transcriptStyle: "detailed" })
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

  it("draws the prompt's Edit and Copy 28px on a phone, like the answer's footer, keeping a 36px hit area", () => {
    render(<AgentView blocks={[request]} currentBlocks={[]} isWorking={false} />)
    for (const name of ["Edit message", "Copy message"]) {
      const classes = screen.getByRole("button", { name }).className.split(/\s+/)
      expect(classes).toContain("max-md:pointer-coarse:size-7")
      expect(classes).toContain("touch-hit")
      expect(classes).toContain("relative")
    }
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
    expect(screen.queryByText("Report from")).toBeNull()
    await userEvent.setup().click(screen.getByRole("button", { name: "Open the replying session in infra" }))
    expect(onOpenSession).toHaveBeenCalledWith("infra-session", "/r/infra")
  })

  it("marks a failure notice", () => {
    render(<AgentView blocks={[reply("error")]} currentBlocks={[]} isWorking={false} />)
    expect(screen.getByText("Workspace update · failed")).toBeTruthy()
    expect(screen.getByText("infra")).toBeTruthy()
  })

  it("shows both directions in the reader transcript too: the request's chip and the folded reply's sender", async () => {
    useDisplayPrefsStore.setState({ transcriptStyle: "reader" })
    const onOpenSession = mock(() => {})
    const answer: ContentBlock = { id: "a1", type: "text", content: "Working on it.", timestamp: new Date() }
    render(<AgentView blocks={[request, answer, reply("completed")]} currentBlocks={[]} isWorking={false} onOpenSession={onOpenSession} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Open the sending session in app" }))
    expect(onOpenSession).toHaveBeenLastCalledWith("app-session", "/r/app")
    // Reader mode folds a reply with the turn's other work: opening the fold shows it.
    await user.click(screen.getByRole("button", { name: /report/ }))
    await user.click(screen.getByRole("button", { name: "Open the replying session in infra" }))
    expect(onOpenSession).toHaveBeenLastCalledWith("infra-session", "/r/infra")
  })
})

describe("AgentView — the lead's messages in a subagent", () => {
  const answer: ContentBlock = { id: "ans", type: "text", content: "On it.", timestamp: new Date() }
  const tagged: ContentBlock = {
    id: "lead-1",
    type: "user",
    content: "[Task from Lead]: Find the flaky test.",
    extra: { from_lead: { session_id: "lead-session" } },
    timestamp: new Date(),
  }
  const untagged: ContentBlock = {
    id: "lead-2",
    type: "user",
    content: "[Lead]: Also check CI.",
    timestamp: new Date(),
  }

  it("chips a tagged row, opens the lead, drops the prefix and offers no Edit", async () => {
    const onOpenSession = mock(() => {})
    render(<AgentView blocks={[tagged, answer]} currentBlocks={[]} isWorking={false} onOpenSession={onOpenSession} />)

    expect(screen.getByText("Find the flaky test.")).toBeTruthy()
    expect(screen.queryByText(/Task from Lead/)).toBeNull()
    const chip = screen.getByRole("button", { name: "Open the lead agent" })
    expect(chip).toHaveTextContent("From")
    expect(chip).toHaveTextContent("lead")
    expect(chip.className).toContain("pointer-coarse:min-h-9")
    await userEvent.setup().click(chip)
    expect(onOpenSession).toHaveBeenCalledWith("lead-session", "")
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull()
    // The lead's prompt is not the user's to rewind from the answer's footer either.
    expect(screen.queryByRole("button", { name: /Edit prompt/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull()
    // It is still copyable.
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy()
  })

  it("keeps Edit prompt on the answer to a user's own prompt (control for the lead case)", () => {
    const own: ContentBlock = { id: "own", type: "user", content: "Do it.", timestamp: new Date() }
    render(<AgentView blocks={[own, answer]} currentBlocks={[]} isWorking={false} onOpenSession={() => {}} />)
    expect(screen.getByRole("button", { name: /Edit prompt/ })).toBeTruthy()
  })

  it("recognises an older untagged `[Lead]: ` row while the session has a parent", async () => {
    useAgentStore.setState({ parentSessionId: "parent-session" })
    const onOpenSession = mock(() => {})
    render(<AgentView blocks={[untagged]} currentBlocks={[]} isWorking={false} onOpenSession={onOpenSession} />)

    expect(screen.getByText("Also check CI.")).toBeTruthy()
    expect(screen.queryByText(/\[Lead\]/)).toBeNull()
    await userEvent.setup().click(screen.getByRole("button", { name: "Open the lead agent" }))
    expect(onOpenSession).toHaveBeenCalledWith("parent-session", "")
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull()
  })

  it("leaves a `[Lead]: ` prefix alone in a session with no parent", () => {
    render(<AgentView blocks={[untagged]} currentBlocks={[]} isWorking={false} onOpenSession={() => {}} />)

    expect(screen.getByText("[Lead]: Also check CI.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open the lead agent" })).toBeNull()
  })

  it("renders the chip as plain text without a navigation handler", () => {
    const { container } = render(<AgentView blocks={[tagged]} currentBlocks={[]} isWorking={false} />)

    expect(screen.queryByRole("button", { name: "Open the lead agent" })).toBeNull()
    const chip = container.querySelector("span[data-from-lead]")
    expect(chip).toHaveTextContent("From")
    expect(chip).toHaveTextContent("lead")
  })

  it("keeps the lead's row right-aligned like a prompt", () => {
    const { container } = render(<AgentView blocks={[tagged]} currentBlocks={[]} isWorking={false} />)
    expect(container.querySelector("[data-user-bubble]")?.className).toContain("justify-end")
  })
})
