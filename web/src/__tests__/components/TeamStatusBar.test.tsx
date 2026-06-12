import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { TeamStatusBar } from "@/components/TeamStatusBar"
import type { AgentStream } from "@/stores/useTeamStore"

afterEach(cleanup)

// Me factory: minimal AgentStream with given status and token count
function makeStream(status: AgentStream["status"], totalTokens = 0): AgentStream {
  return {
    blocks: [],
    currentBlocks: [],
    currentText: "",
    currentThinking: "",
    status,
    usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens, cachedTokens: 0 },
    model: null,
    lastError: null,
    _completionBase: 0,
  }
}

describe("TeamStatusBar", () => {
  // ── session ID ──────────────────────────────────────────────────────────────

  it("shows first 8 chars of sessionId", () => {
    render(
      <TeamStatusBar
        sessionId="abcdef1234567890"
        agentStreams={{}}
      />
    )
    expect(screen.getByText("abcdef12")).toBeTruthy()
  })

  it("omits session ID section when sessionId is null", () => {
    render(<TeamStatusBar sessionId={null} agentStreams={{}} />)
    // Me no session prefix visible
    const mono = screen.queryByText(/abcdef/)
    expect(mono).toBeNull()
  })

  // ── lead name ───────────────────────────────────────────────────────────────

  it("shows lead name when provided", () => {
    render(
      <TeamStatusBar
        sessionId={null}
        leadName="orchestrator"
        agentStreams={{}}
      />
    )
    expect(screen.getByText("lead: orchestrator")).toBeTruthy()
  })

  it("omits lead label when leadName is null", () => {
    render(<TeamStatusBar sessionId={null} agentStreams={{}} />)
    const lead = screen.queryByText(/lead:/)
    expect(lead).toBeNull()
  })

  // ── working indicator ───────────────────────────────────────────────────────

  it("shows 'working' label when isWorking=true", () => {
    render(<TeamStatusBar sessionId={null} isWorking={true} agentStreams={{}} />)
    expect(screen.getByText("working")).toBeTruthy()
  })

  it("does not show 'working' label when isWorking=false", () => {
    render(<TeamStatusBar sessionId={null} isWorking={false} agentStreams={{}} />)
    const working = screen.queryByText("working")
    expect(working).toBeNull()
  })

  // ── error display ───────────────────────────────────────────────────────────

  it("shows error text when error is provided", () => {
    render(
      <TeamStatusBar
        sessionId={null}
        error="Team connection lost"
        agentStreams={{}}
      />
    )
    expect(screen.getByText("Team connection lost")).toBeTruthy()
  })

  it("does not show error when error is null", () => {
    render(<TeamStatusBar sessionId={null} error={null} agentStreams={{}} />)
    const err = screen.queryByText(/connection/)
    expect(err).toBeNull()
  })

  // ── agent pills ─────────────────────────────────────────────────────────────

  it("renders agent name pills for each agent stream", () => {
    const agentStreams = {
      "agent-alpha": makeStream("idle"),
      "agent-beta": makeStream("working"),
    }
    render(<TeamStatusBar sessionId={null} agentStreams={agentStreams} />)
    expect(screen.getByText("agent-alpha")).toBeTruthy()
    expect(screen.getByText("agent-beta")).toBeTruthy()
  })

  it("shows token count when agent has totalTokens > 0", () => {
    const agentStreams = { "bot": makeStream("idle", 1500) }
    render(<TeamStatusBar sessionId={null} agentStreams={agentStreams} />)
    // Me formatTokens(1500) = "1.5k"
    expect(screen.getByText("1.5k")).toBeTruthy()
  })

  it("omits token count when totalTokens is 0", () => {
    const agentStreams = { "bot": makeStream("idle", 0) }
    render(<TeamStatusBar sessionId={null} agentStreams={agentStreams} />)
    const kText = screen.queryByText(/k$/)
    expect(kText).toBeNull()
  })

  // ── status dot colors ────────────────────────────────────────────────────────

  it("working agent gets yellow dot class", () => {
    const { container } = render(
      <TeamStatusBar
        sessionId={null}
        agentStreams={{ "worker": makeStream("working") }}
      />
    )
    // Component uses CSS variable bg-(--color-accent) for working status
    const yellowDot = container.querySelector("[class*='bg-(--color-accent)']")
    expect(yellowDot).toBeTruthy()
  })

  it("error agent gets red dot class", () => {
    const { container } = render(
      <TeamStatusBar
        sessionId={null}
        agentStreams={{ "worker": makeStream("error") }}
      />
    )
    // Component uses CSS variable bg-(--color-error) for error status
    const redDot = container.querySelector("[class*='bg-(--color-error)']")
    expect(redDot).toBeTruthy()
  })

  it("idle agent gets green dot class", () => {
    const { container } = render(
      <TeamStatusBar
        sessionId={null}
        agentStreams={{ "worker": makeStream("idle") }}
      />
    )
    // Component uses CSS variable bg-(--color-success) for idle status
    const greenDot = container.querySelector("[class*='bg-(--color-success)']")
    expect(greenDot).toBeTruthy()
  })

  // ── combined rendering ──────────────────────────────────────────────────────

  it("renders all elements together correctly", () => {
    const agentStreams = {
      "lead-agent": makeStream("working", 500),
      "sub-agent": makeStream("idle", 0),
    }
    render(
      <TeamStatusBar
        sessionId="session-abc12345"
        leadName="lead-agent"
        isWorking={true}
        error={null}
        agentStreams={agentStreams}
      />
    )
    expect(screen.getByText("session-")).toBeTruthy()
    expect(screen.getByText("lead: lead-agent")).toBeTruthy()
    expect(screen.getByText("working")).toBeTruthy()
    expect(screen.getByText("lead-agent")).toBeTruthy()
    expect(screen.getByText("sub-agent")).toBeTruthy()
    expect(screen.getByText("500")).toBeTruthy()
  })
})
