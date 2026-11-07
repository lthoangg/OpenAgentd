/**
 * Most tools' output stays on the server. The row shows the call (name,
 * target, time) with no result summary or failure mark; opening it fetches
 * the output once; the row's menu fetches nothing.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"

const fetched: Array<[string, string]> = []
const argsFetched: string[] = []
let missesLeft = 0
let answer = "[1-2/2]\nfirst line\nsecond line"
mock.module("@/api/client/tool-results", () => ({
  toolResult: mock(async (...args: unknown[]) => {
    const [sessionId, toolCallId] = args as [string, string]
    fetched.push([sessionId, toolCallId])
    if (missesLeft > 0) { missesLeft -= 1; throw new Error("Tool result not found.") }
    return { tool_call_id: toolCallId, name: "read", content: answer }
  }),
  toolCallArguments: mock(async (...args: unknown[]) => {
    const [, toolCallId] = args as [string, string]
    argsFetched.push(toolCallId)
    return { tool_call_id: toolCallId, name: "shell", arguments: JSON.stringify({ command: "bun test --all", description: "run tests" }) }
  }),
}))

import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react"
import { ToolCall } from "@/components/ToolCall"
import { clearToolResultCache } from "@/components/ToolCall/useToolResult"
import { useAgentStore } from "@/stores/useAgentStore"

afterEach(cleanup)
beforeEach(() => {
  fetched.length = 0
  argsFetched.length = 0
  missesLeft = 0
  answer = "[1-2/2]\nfirst line\nsecond line"
  clearToolResultCache()
  useAgentStore.setState({ sessionId: "s1" })
  Object.defineProperty(navigator, "clipboard", { value: { writeText: mock(() => Promise.resolve()) }, configurable: true, writable: true })
})

function row(): HTMLElement {
  return document.querySelector("[data-tool-label]") as HTMLElement
}

describe("a tool result fetched on demand", () => {
  it("fetches nothing until the row is opened, then shows the output", async () => {
    render(<ToolCall name="read" args='{"path":"a.rs"}' done toolCallId="c1" resultBytes={31} />)
    expect(fetched).toEqual([])
    fireEvent.click(row())
    await waitFor(() => expect(screen.getByText("second line")).toBeTruthy())
    expect(fetched).toEqual([["s1", "c1"]])
  })

  it("fetches once however often the row is reopened", async () => {
    render(<ToolCall name="grep" args='{"pattern":"x"}' done toolCallId="c2" resultBytes={10} />)
    fireEvent.click(row())
    await waitFor(() => expect(fetched.length).toBe(1))
    fireEvent.click(row())
    fireEvent.click(row())
    await waitFor(() => expect(screen.getByText(/second line/)).toBeTruthy())
    expect(fetched.length).toBe(1)
  })

  it("shows no result summary and no failure mark on the row", () => {
    render(<ToolCall name="shell" args='{"command":"cargo test"}' done toolCallId="c3" result={"[Failed — exit code 1]\ntest result: FAILED. 3 passed; 1 failed"} />)
    expect(row().textContent).not.toMatch(/passed|failed|error|no output/i)
    render(<ToolCall name="grep" args='{"pattern":"x"}' done toolCallId="c4" result={"Error: bad pattern"} />)
    expect(document.body.textContent).not.toMatch(/\berror\b/)
  })

  it("fetches nothing for the row's menu: a shell row has none", () => {
    answer = "the whole output"
    render(<ToolCall name="shell" args='{"command":"ls"}' done toolCallId="c5" resultBytes={16} />)
    expect(fireEvent.contextMenu(row())).toBe(true)
    expect(fetched).toEqual([])
  })

  it("loads a described shell call's command when opened: the live event carried only the description", async () => {
    answer = "[Succeeded]\n\nall green"
    render(<ToolCall name="shell" args='{"description":"run tests"}' done toolCallId="c7" resultBytes={20} />)
    fireEvent.click(row())
    await waitFor(() => expect(screen.getByText(/all green/)).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toContain("bun test --all"))
    expect(argsFetched).toEqual(["c7"])
    expect(document.body.textContent).toContain("terminal")
  })

  it("retries a result not written yet, inside the terminal, instead of showing an error", async () => {
    missesLeft = 1
    answer = "[Succeeded]\n\nlate output"
    render(<ToolCall name="shell" args='{"command":"ls"}' done toolCallId="c8" resultBytes={20} />)
    fireEvent.click(row())
    await waitFor(() => expect(screen.getByText(/late output/)).toBeTruthy(), { timeout: 3000 })
    expect(document.body.textContent).not.toContain("Could not load")
    expect(document.body.textContent).not.toContain("result")
  })

  // An applied patch's answer stays on the server: the row's stats come from
  // the arguments, and opening it brings the diagnostics.
  it("shows an applied patch's stats without its answer, and its diagnostics once opened", async () => {
    answer = "Patch applied successfully. Updated paths:\na.py\n\n[LSP Diagnostics]\n- a.py:1:9: error: unexpected EOF while parsing (Ruff)"
    const args = JSON.stringify({ patch_text: "*** Begin Patch\n*** Update File: a.py\n@@\n-old\n+new\n+more\n*** End Patch" })
    render(<ToolCall name="patch" args={args} done toolCallId="c6" resultBytes={answer.length} />)
    expect(row().textContent).toContain("+2")
    expect(fetched).toEqual([])
    fireEvent.click(row())
    await waitFor(() => expect(screen.getByText(/unexpected EOF while parsing/)).toBeTruthy())
    expect(fetched).toEqual([["s1", "c6"]])
  })
})
