import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import { AgentView } from "@/components/AgentView"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

function makeQuotaBlock(
  id: string,
  model = "codex:gpt-5.4",
  message?: string
): ContentBlock {
  return {
    id,
    type: "provider_status",
    content: "",
    extra: {
      status: "waiting_quota",
      model,
      message,
      delay_seconds: 7202,
      retry_after: 7200,
    },
  }
}

describe("AgentView — waiting_quota status rendering", () => {
  it("renders quota wait block with custom message", () => {
    const customMsg =
      "Provider quota exhausted for codex:gpt-5.4. Waiting 2h 00m for reset. Agent will automatically resume work. You can stop anytime."
    render(
      <AgentView
        blocks={[makeQuotaBlock("q1", "codex:gpt-5.4", customMsg)]}
        currentBlocks={[]}
        isWorking={true}
      />
    )

    expect(screen.getByText("Quota Limit Reached · Waiting for Reset")).toBeTruthy()
    expect(screen.getByText(customMsg)).toBeTruthy()
  })

  it("renders default message when custom message is omitted", () => {
    render(
      <AgentView
        blocks={[makeQuotaBlock("q2", "copilot:claude-sonnet-4")]}
        currentBlocks={[]}
        isWorking={true}
      />
    )

    expect(screen.getByText("Quota Limit Reached · Waiting for Reset")).toBeTruthy()
    expect(
      screen.getByText(
        "Provider quota exhausted for copilot:claude-sonnet-4. Waiting for reset. Agent will automatically resume work. You can stop anytime."
      )
    ).toBeTruthy()
  })
})
