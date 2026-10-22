/**
 * Clicking a sent attachment opens it in the dock when the chat has one,
 * and in the full-screen lightbox otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import type { FileRefOpener } from "@/components/FileRefLink"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock, MessageAttachment } from "@/api/types"

beforeEach(() => {
  useAgentStore.setState({ sessionId: "s1" })
})

afterEach(cleanup)

function prompt(attachment: MessageAttachment): ContentBlock {
  return { id: "u1", type: "user", content: "see attached", attachments: [attachment], timestamp: new Date() }
}

const report: MessageAttachment = {
  filename: "report.pdf",
  original_name: "report.pdf",
  media_type: "application/pdf",
  category: "document",
  url: "/api/agent/s1/uploads/report.pdf",
  source: "upload",
}

function opener(openAttachment?: FileRefOpener["openAttachment"]): FileRefOpener {
  return { workspace: "/w", canOpen: () => true, open: () => {}, ...(openAttachment ? { openAttachment } : {}) }
}

describe("UserBubble attachments", () => {
  it("opens a saved attachment in the dock when one is available", async () => {
    const openAttachment = mock(() => {})
    render(<AgentView blocks={[prompt(report)]} currentBlocks={[]} isWorking={false} fileRefOpener={opener(openAttachment)} />)

    await userEvent.setup().click(screen.getByRole("button", { name: /report\.pdf/ }))

    expect(openAttachment).toHaveBeenCalledTimes(1)
    const [item] = (openAttachment.mock.calls[0] ?? []) as unknown as [{ type: string; name: string; src: string }]
    expect(item.type).toBe("pdf")
    expect(item.name).toBe("report.pdf")
    expect(item.src).toContain("/api/agent/s1/uploads/report.pdf")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("falls back to the lightbox without a dock", async () => {
    render(<AgentView blocks={[prompt(report)]} currentBlocks={[]} isWorking={false} fileRefOpener={opener()} />)

    await userEvent.setup().click(screen.getByRole("button", { name: /report\.pdf/ }))

    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("keeps a still-sending blob attachment in the lightbox", async () => {
    const openAttachment = mock(() => {})
    const pending = { ...report, url: "blob:http://localhost/abc" }
    render(<AgentView blocks={[prompt(pending)]} currentBlocks={[]} isWorking={false} fileRefOpener={opener(openAttachment)} />)

    await userEvent.setup().click(screen.getByRole("button", { name: /report\.pdf/ }))

    expect(openAttachment).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeTruthy()
  })
})
