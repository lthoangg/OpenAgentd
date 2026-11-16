/**
 * The transcript's rarer rows, as a reader sees them: a reply that ends the
 * agent's turn with a sleep mark, and the provider notes that carry no card.
 */
import { afterEach, describe, expect, it, mock } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom"
import { AgentView } from "@/components/AgentView"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

function view(blocks: ContentBlock[]) {
  return render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
}

describe("AgentView — a reply ending in a sleep mark", () => {
  it("shows the reply's text and then an Agent idle note, without the mark", () => {
    view([
      { id: "u1", type: "user", content: "wait for the build" },
      { id: "t1", type: "text", content: "Build started. <sleep>" },
    ])
    expect(screen.getByText("Build started.")).toBeInTheDocument()
    expect(screen.getByRole("note")).toHaveTextContent("Agent idle")
    expect(screen.queryByText(/<sleep>/)).toBeNull()
  })

  it("shows only the idle note when the reply is the bare mark", () => {
    view([
      { id: "u1", type: "user", content: "wait" },
      { id: "t1", type: "text", content: "[sleep]" },
    ])
    expect(screen.getByRole("note")).toHaveTextContent("Agent idle")
    expect(screen.queryByText(/\[sleep\]/)).toBeNull()
  })
})

describe("AgentView — provider notes without a card", () => {
  it("says the pinned account is gone when a pin is released", () => {
    view([
      { id: "u1", type: "user", content: "hi" },
      { id: "p1", type: "provider_status", content: "", extra: { status: "pin_released" } },
    ])
    expect(screen.getByText("The account this session started on is gone, so it uses the provider's next available account.")).toBeInTheDocument()
  })

  it("shows the server's own words for a released pin when it sends them", () => {
    view([
      { id: "u1", type: "user", content: "hi" },
      { id: "p1", type: "provider_status", content: "", extra: { status: "pin_released", message: "Work was removed." } },
    ])
    expect(screen.getByText("Work was removed.")).toBeInTheDocument()
  })

  it("says the status changed for a status it does not know", () => {
    view([
      { id: "u1", type: "user", content: "hi" },
      { id: "p1", type: "provider_status", content: "", extra: { status: "something_new" } },
    ])
    expect(screen.getByText("Provider status updated.")).toBeInTheDocument()
  })
})
