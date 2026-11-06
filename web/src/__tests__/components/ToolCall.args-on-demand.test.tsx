/**
 * History sends a few tools' arguments short (a described shell call
 * without its command, a patch as its files and line counts, a plan without
 * its Markdown) with ``arguments_bytes`` beside them. The row reads the
 * short form; opening it fetches the full arguments once.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"

const fetched: string[] = []
const full: Record<string, string> = {}
mock.module("@/api/client/tool-results", () => ({
  toolResult: mock(async (...args: unknown[]) => ({ tool_call_id: args[1] as string, name: "shell", content: "[Succeeded]\nok" })),
  toolCallArguments: mock(async (...args: unknown[]) => {
    const toolCallId = args[1] as string
    fetched.push(toolCallId)
    return { tool_call_id: toolCallId, name: "x", arguments: full[toolCallId] }
  }),
}))

import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react"
import { ToolCall } from "@/components/ToolCall"
import { clearToolResultCache } from "@/components/ToolCall/useToolResult"
import { useAgentStore } from "@/stores/useAgentStore"

afterEach(cleanup)
beforeEach(() => {
  fetched.length = 0
  clearToolResultCache()
  useAgentStore.setState({ sessionId: "s1" })
  Object.defineProperty(navigator, "clipboard", { value: { writeText: mock(() => Promise.resolve()) }, configurable: true, writable: true })
})

function row(): HTMLElement {
  return document.querySelector("[data-tool-label]") as HTMLElement
}

/** The open details' text (a command is split into highlighted tokens). */
function details(): string {
  return Array.from(document.querySelectorAll("section")).map((s) => s.textContent).join("\n")
}

const PATCH = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old line\n+new line\n+added line\n*** End Patch"
const SHORT_PATCH = JSON.stringify({ files: [{ path: "src/a.ts", kind: "update", additions: 2, deletions: 1 }] })

describe("tool arguments fetched on demand", () => {
  it("shows a described shell call's description and fetches the command when opened", async () => {
    full.c1 = JSON.stringify({ command: "cargo test --workspace", description: "Run every test" })
    render(<ToolCall name="shell" args='{"description":"Run every test"}' argsBytes={70} done toolCallId="c1" result="[Succeeded]\nok" />)
    expect(row().textContent).toContain("Run every test")
    expect(fetched).toEqual([])
    fireEvent.click(row())
    await waitFor(() => expect(details()).toContain("$ cargo test --workspace"))
    expect(fetched).toEqual(["c1"])
  })

  it("names a patch's files and line counts before fetching its diff", async () => {
    full.c2 = JSON.stringify({ patch_text: PATCH })
    render(<ToolCall name="patch" args={SHORT_PATCH} argsBytes={PATCH.length} done toolCallId="c2" result="Patch applied successfully." />)
    expect(row().textContent).toContain("a.ts")
    expect(screen.getByText("+2")).toBeTruthy()
    expect(screen.getByText("−1")).toBeTruthy()
    expect(fetched).toEqual([])
    fireEvent.click(row())
    await waitFor(() => expect(screen.getByText("added line")).toBeTruthy())
    expect(fetched).toEqual(["c2"])
  })

  it("fetches nothing for the row's menu: a shell row has none", () => {
    full.c3 = JSON.stringify({ command: "rm -rf build && make", description: "Rebuild" })
    render(<ToolCall name="shell" args='{"description":"Rebuild"}' argsBytes={60} done toolCallId="c3" result="[Succeeded]\n" />)
    expect(fireEvent.contextMenu(row())).toBe(true)
    expect(screen.queryByRole("menu")).toBeNull()
    expect(fetched).toEqual([])
  })

  it("uses arguments that came whole without fetching", async () => {
    render(<ToolCall name="shell" args='{"command":"ls","description":"List"}' done toolCallId="c4" result="[Succeeded]\na" />)
    fireEvent.click(row())
    await waitFor(() => expect(details()).toContain("$ ls"))
    expect(fetched).toEqual([])
  })
})
