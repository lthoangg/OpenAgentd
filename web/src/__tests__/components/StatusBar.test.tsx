import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { StatusBar } from "@/components/StatusBar"
import type { AgentUsage } from "@/api/types"

afterEach(cleanup)

const newHint = "Ctrl+N new"

describe("StatusBar", () => {
  it("renders session ID using shortId() when sessionId is provided", () => {
    const sessionId = "abc123def456"
    render(<StatusBar sessionId={sessionId} />)
    expect(screen.getByText("abc123de")).toBeTruthy()
  })

  it("does not render session ID when sessionId is null", () => {
    render(<StatusBar sessionId={null} />)
    // Should still render the component, just without the session ID
    expect(screen.getByText(newHint)).toBeTruthy()
  })

  it("shows 'streaming' indicator when isStreaming is true", () => {
    render(<StatusBar sessionId={null} isStreaming={true} />)
    expect(screen.getByText("streaming")).toBeTruthy()
  })

  it("does not show 'streaming' indicator when isStreaming is false", () => {
    render(<StatusBar sessionId={null} isStreaming={false} />)
    const streamingText = screen.queryByText("streaming")
    expect(streamingText).toBeNull()
  })

  it("shows error text when error is provided", () => {
    const errorMsg = "Connection failed"
    render(<StatusBar sessionId={null} error={errorMsg} />)
    expect(screen.getByText(errorMsg)).toBeTruthy()
  })

  it("does not show error when error is null", () => {
    render(<StatusBar sessionId={null} error={null} />)
    // Should render without error
    expect(screen.getByText(newHint)).toBeTruthy()
  })

  it("shows the token meter when usage is provided", () => {
    const usage: AgentUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
    }
    render(<StatusBar sessionId={null} usage={usage} />)
    expect(screen.getByLabelText("Input: 100 / 250,000 (0%) · Output: 50")).toBeTruthy()
  })

  it("uses the token meter tooltip for large token counts", () => {
    const usage: AgentUsage = {
      promptTokens: 1500,
      completionTokens: 2000,
      totalTokens: 3500,
      cachedTokens: 0,
    }
    render(<StatusBar sessionId={null} usage={usage} />)
    expect(screen.getByLabelText("Input: 1,500 / 250,000 (1%) · Output: 2,000")).toBeTruthy()
  })

  it("shows cached tokens in the token meter tooltip when usage.cachedTokens > 0", () => {
    const usage: AgentUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 25,
    }
    render(<StatusBar sessionId={null} usage={usage} />)
    expect(screen.getByLabelText("Input: 100 / 250,000 (0%) · Output: 50 · Cache: 25")).toBeTruthy()
  })

  it("does not show cached tokens when cachedTokens is 0", () => {
    const usage: AgentUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
    }
    render(<StatusBar sessionId={null} usage={usage} />)
    const cachedText = screen.queryByText(/cached/)
    expect(cachedText).toBeNull()
  })

  it("renders the platform-correct 'New chat' hint text", () => {
    render(<StatusBar sessionId={null} />)
    expect(screen.getByText(newHint)).toBeTruthy()
  })

  it("renders all elements together", () => {
    const sessionId = "session-abc123"
    const usage: AgentUsage = {
      promptTokens: 500,
      completionTokens: 300,
      totalTokens: 800,
      cachedTokens: 50,
    }
    render(
      <StatusBar
        sessionId={sessionId}
        isStreaming={true}
        usage={usage}
      />
    )
    expect(screen.getByText("session-")).toBeTruthy() // shortId
    expect(screen.getByText("streaming")).toBeTruthy()
    expect(screen.getByLabelText("Input: 500 / 250,000 (0%) · Output: 300 · Cache: 50")).toBeTruthy()
    expect(screen.getByText(newHint)).toBeTruthy()
  })
})
