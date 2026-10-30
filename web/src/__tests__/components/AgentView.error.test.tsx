import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom"
import { AgentView } from "@/components/AgentView"
import { useDisplayPrefsStore } from "@/stores/useDisplayPrefsStore"
import type { ContentBlock } from "@/api/types"

afterEach(() => {
  cleanup()
  useDisplayPrefsStore.setState({ transcriptStyle: "detailed" })
})

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTextBlock(id: string, content: string): ContentBlock {
  return { id, type: "text", content }
}

function makeUserBlock(id: string): ContentBlock {
  return { id, type: "user", content: "hello" }
}

// ── isError / lastError props ─────────────────────────────────────────────────

describe("AgentView — error state", () => {
  it("renders nothing special when isError is false", () => {
    render(
      <AgentView
        blocks={[makeTextBlock("b1", "some output")]}
        currentBlocks={[]}
        isWorking={false}
        isError={false}
        lastError="should not appear"
      />
    )
    expect(screen.queryByText("should not appear")).toBeNull()
  })

  it("renders error box when isError=true and lastError is set", () => {
    render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={false}
        isError={true}
        lastError="LLM provider unavailable"
      />
    )
    expect(screen.getByText("LLM provider unavailable")).toBeTruthy()
  })

  it("does not render error box when isError=true but lastError is null", () => {
    const { container } = render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={false}
        isError={true}
        lastError={null}
      />
    )
    // No red error box rendered
    const errorBox = container.querySelector("[class*='color-error']")
    expect(errorBox).toBeNull()
  })

  it("does not render error box when isError is undefined", () => {
    render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={false}
        lastError="ghost error"
      />
    )
    expect(screen.queryByText("ghost error")).toBeNull()
  })

  it("shows error box alongside existing blocks", () => {
    render(
      <AgentView
        blocks={[makeTextBlock("b1", "partial output")]}
        currentBlocks={[]}
        isWorking={false}
        isError={true}
        lastError="Rate limit hit"
      />
    )
    expect(screen.getByText("partial output")).toBeTruthy()
    expect(screen.getByText("Rate limit hit")).toBeTruthy()
  })

  it("does not show bouncing dots when isError=true", () => {
    // Bouncing dots appear when isWorking=true with only user blocks.
    // Error state should never show dots.
    const { container } = render(
      <AgentView
        blocks={[]}
        currentBlocks={[makeUserBlock("u1")]}
        isWorking={false}
        isError={true}
        lastError="Something went wrong"
      />
    )
    const dots = container.querySelectorAll("[class*='animate-bounce']")
    expect(dots.length).toBe(0)
  })
})

// ── isError prop is optional — no regressions ─────────────────────────────────

describe("AgentView — omitting isError/lastError props", () => {
  it("renders normally without isError or lastError props", () => {
    render(
      <AgentView
        blocks={[makeTextBlock("b1", "hello world")]}
        currentBlocks={[]}
        isWorking={false}
      />
    )
    expect(screen.getByText("hello world")).toBeTruthy()
  })

  it("shows working dots without isError prop", () => {
    const { container } = render(
      <AgentView
        blocks={[]}
        currentBlocks={[makeUserBlock("u1")]}
        isWorking={true}
      />
    )
    const dots = container.querySelectorAll("[class*='animate-bounce']")
    expect(dots.length).toBe(3)
  })
})

// ── the way forward from an error ─────────────────────────────────────────────

function providerError(id: string, message: string): ContentBlock {
  return {
    id,
    type: "provider_status",
    content: message,
    extra: { type: "provider_status", status: "error", title: "Provider Error", message, category: "provider" },
    timestamp: new Date("2026-01-01T10:00:00Z"),
  }
}

const ENDED_IN_ERROR: ContentBlock[] = [
  { id: "m1", type: "user", content: "first prompt" },
  { id: "a1", type: "text", content: "first answer" },
  { id: "m2", type: "user", content: "second prompt" },
  { id: "a2", type: "text", content: "partial answer" },
  providerError("e2", "Rate limit exceeded"),
]

describe("AgentView — error card actions", () => {
  it("offers Retry and Switch model on the error a turn ended with", () => {
    const onRetry = mock(() => {})
    const onSwitchModel = mock(() => {})
    render(<AgentView blocks={ENDED_IN_ERROR} currentBlocks={[]} isWorking={false} onRetry={onRetry} onSwitchModel={onSwitchModel} />)

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Switch model" }))
    expect(onSwitchModel).toHaveBeenCalledTimes(1)
  })

  it("leaves an error the agent recovered from without actions", () => {
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "prompt" },
      providerError("e1", "Rate limit exceeded"),
      { id: "a1", type: "text", content: "answer after the fallback model" },
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.getByText("Rate limit exceeded")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull()
  })

  it("leaves errors in earlier turns without actions", () => {
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "prompt" },
      providerError("e1", "Rate limit exceeded"),
      { id: "m2", type: "user", content: "try again" },
      { id: "a2", type: "text", content: "answer" },
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull()
  })

  it("offers no actions while the turn is open", () => {
    render(<AgentView blocks={ENDED_IN_ERROR} currentBlocks={[]} isWorking={false} isTurnOpen onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull()
  })

  it("offers no Retry when a subagent's report came in after the prompt, even folded in reader mode", () => {
    useDisplayPrefsStore.setState({ transcriptStyle: "reader" })
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "prompt" },
      { id: "d1", type: "tool", content: "", toolName: "delegate", toolDone: true },
      { id: "r1", type: "user", content: "report", extra: { from_agent: "explorer#1" } },
      providerError("e1", "Rate limit exceeded"),
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.getByRole("button", { name: "Switch model" })).toBeTruthy()
  })

  it("shows a turn error once when the transcript already carries it", () => {
    render(
      <AgentView
        blocks={ENDED_IN_ERROR}
        currentBlocks={[]}
        isWorking={false}
        isError
        lastError="Rate limit exceeded"
        onRetry={() => {}}
        onSwitchModel={() => {}}
      />
    )

    expect(screen.getAllByText("Rate limit exceeded")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
  })

  it("gives a failure the transcript does not show its own card, with the same actions", () => {
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "first prompt" },
      { id: "a1", type: "text", content: "first answer" },
      { id: "m2", type: "user", content: "second prompt" },
    ]
    const onRetry = mock(() => {})
    render(
      <AgentView
        blocks={blocks}
        currentBlocks={[]}
        isWorking={false}
        isError
        lastError="Agent crashed"
        onRetry={onRetry}
        onSwitchModel={() => {}}
      />
    )

    expect(screen.getByText("Agent crashed")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Switch model" })).toBeTruthy()
  })
})

describe("AgentView — provider retry notice", () => {
  function retrying(extra: Record<string, unknown>): ContentBlock {
    return {
      id: "r1",
      type: "provider_status",
      content: "",
      extra: { status: "retrying", model: "openai:gpt", attempt: 3, delay_seconds: 4.2, error_type: "RemoteProtocolError", ...extra },
    }
  }

  it("counts attempts without a budget while waiting for the network", () => {
    render(<AgentView blocks={[]} currentBlocks={[retrying({ max_attempts: null })]} isWorking />)
    const notice = screen.getByRole("status")
    expect(notice.textContent).toBe("Retrying gpt · attempt 3 · in 4.2 sRemoteProtocolError")
    expect(screen.getByText("RemoteProtocolError").closest("[data-slot=chip]")).toBeTruthy()
  })

  it("shows the budget when the retries have one", () => {
    render(<AgentView blocks={[]} currentBlocks={[retrying({ max_attempts: 5, error_type: "HTTPStatusError", status_code: 503 })]} isWorking />)
    expect(screen.getByRole("status").textContent).toBe("Retrying gpt · attempt 3/5 · in 4.2 s503 HTTPStatusError")
  })

  it("says which credential the turn moved to when one hits its limit", () => {
    const block: ContentBlock = {
      id: "s1",
      type: "provider_status",
      content: "",
      extra: {
        status: "switched_credential",
        model: "openai:gpt",
        error_type: "HTTPStatusError",
        status_code: 429,
        message: "Personal hit its usage limit (resets in 2h). Continuing on Work with the same model.",
      },
    }
    render(<AgentView blocks={[]} currentBlocks={[block]} isWorking />)
    expect(screen.getByText("Personal hit its usage limit (resets in 2h). Continuing on Work with the same model.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })
})
