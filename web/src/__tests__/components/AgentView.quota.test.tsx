import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from "bun:test"
import { act, render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

beforeEach(() => {
  localStorage.clear()
  act(() => {
    useAgentStore.setState({ sessionId: "quota-session" })
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  act(() => {
    useAgentStore.setState({ sessionId: null })
  })
})

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

function makeQuotaBlock(
  id: string,
  model = "codex:gpt-5.4",
  message?: string,
  resetsAt = Math.floor(Date.now() / 1000) + 7200,
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
      resets_at: resetsAt,
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
    expect(screen.getByText("Resets in 2h 00m")).toBeTruthy()
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
    expect(screen.getByText("Resets in 2h 00m")).toBeTruthy()
    expect(
      screen.getByText(
        "Provider quota exhausted for copilot:claude-sonnet-4. Waiting for reset. Agent will automatically resume work. You can stop anytime."
      )
    ).toBeTruthy()
  })

  it("updates the countdown every minute", () => {
    const start = Date.now()
    const dateNow = spyOn(Date, "now").mockReturnValue(start)
    const nativeSetInterval = window.setInterval
    const nativeClearInterval = window.clearInterval
    let tick: (() => void) | undefined
    window.setInterval = ((callback: TimerHandler) => {
      tick = callback as () => void
      return 1
    }) as typeof window.setInterval
    window.clearInterval = (() => {}) as typeof window.clearInterval

    try {
      render(
        <AgentView
          blocks={[makeQuotaBlock("q-minute", "codex:gpt-5.4", undefined, start / 1000 + 7200)]}
          currentBlocks={[]}
          isWorking={true}
        />,
      )
      expect(screen.getByText("Resets in 2h 00m")).toBeTruthy()

      dateNow.mockReturnValue(start + 60_000)
      act(() => tick?.())

      expect(screen.getByText("Resets in 1h 59m")).toBeTruthy()
    } finally {
      window.setInterval = nativeSetInterval
      window.clearInterval = nativeClearInterval
      dateNow.mockRestore()
    }
  })

  it("restores the active quota wait after a page refresh", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 7200
    const firstRender = render(
      <AgentView
        blocks={[makeQuotaBlock("q3", "codex:gpt-5.4", undefined, resetAt)]}
        currentBlocks={[]}
        isWorking={true}
      />,
    )

    expect(screen.getByText("Resets in 2h 00m")).toBeTruthy()
    firstRender.unmount()

    render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={true}
      />,
    )

    expect(screen.getByText("Quota Limit Reached · Waiting for Reset")).toBeTruthy()
    expect(screen.getByText("Resets in 2h 00m")).toBeTruthy()
  })
})
