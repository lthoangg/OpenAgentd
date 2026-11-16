/**
 * The `script` row: its description as the target, the code, the nested
 * calls (live while it runs, from the stored result after a reload), and the
 * output with any error, time-limit note and save note.
 */
import { describe, it, expect, afterEach, mock } from "bun:test"

let stored = ""
mock.module("@/api/client/tool-results", () => ({
  toolResult: mock(async (...args: unknown[]) => {
    const [, toolCallId] = args as [string, string]
    return { tool_call_id: toolCallId, name: "script", content: stored }
  }),
  toolCallArguments: mock(async () => ({ tool_call_id: "x", name: "script", arguments: "{}" })),
}))

import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { ToolCall } from "@/components/ToolCall"
import { clearToolResultCache } from "@/components/ToolCall/useToolResult"
import { parseScriptLive, parseScriptResult } from "@/components/ToolCall/scriptTrace"
import { useAgentStore } from "@/stores/useAgentStore"

afterEach(() => {
  cleanup()
  clearToolResultCache()
})

const CODE = 'const files = await tools.glob({ pattern: "src/*.txt" });\nconsole.log(files);'
const ARGS = JSON.stringify({ description: "Count TODOs per crate", code: CODE })
const RESULT = [
  "calls (3, 1.8 s):",
  "→ glob src/*.txt · 8 ms · 14 lines",
  '→ grep "TODO" in crates/agent · 41 ms · 11 lines',
  '→ grep "TODO" in crates/vendor · error: path does not exist',
  "output:",
  '[ ["agent", 11] ]',
  "saved as count-todos (.agents/scripts/count-todos.ts)",
].join("\n")

function open() {
  fireEvent.click(document.querySelector("[data-tool-label]") as HTMLElement)
}

describe("script results", () => {
  it("parse the calls, output, error and save note", () => {
    const run = parseScriptResult(RESULT)!
    expect(run.total).toBe(3)
    expect(run.seconds).toBe(1.8)
    expect(run.calls.map((c) => [c.name, c.target, c.status, c.detail])).toEqual([
      ["glob", "src/*.txt", "ok", "8 ms · 14 lines"],
      ["grep", '"TODO" in crates/agent', "ok", "41 ms · 11 lines"],
      ["grep", '"TODO" in crates/vendor', "error", "path does not exist"],
    ])
    expect(run.output).toBe('[ ["agent", 11] ]')
    expect(run.saved).toBe("saved as count-todos (.agents/scripts/count-todos.ts)")
    expect(run.error).toBeNull()

    const stopped = parseScriptResult(
      "calls (2, 270.0 s):\n→ mcp call deploy/status · 212 ms · 3 lines\n→ mcp call deploy/status · cancelled\noutput:\nstatus: building\nerror: stopped after 270 s, the time limit of a script. The limit keeps the prompt cache warm.",
    )!
    expect(stopped.timedOut).toBe(true)
    expect(stopped.calls[1].status).toBe("cancelled")
    expect(stopped.output).toBe("status: building")
    expect(parseScriptResult("Error: Give exactly one of code, path, name or list.")).toBeNull()
    expect(parseScriptResult("calls (0, 0.0 s):\noutput:\n(nothing logged or returned)")!.output).toBe("")
  })

  it("parse live events into running and finished calls", () => {
    const calls = parseScriptLive('▸ 1 glob src/*.txt\n▸ 2 grep "TODO"\n✓ 1 8 ms · 14 lines\n▸ 3 read\n✗ 3 error: File not found: x\n')
    expect(calls.map((c) => [c.name, c.status, c.detail])).toEqual([
      ["glob", "ok", "8 ms · 14 lines"],
      ["grep", "running", ""],
      ["read", "error", "File not found: x"],
    ])
  })
})

describe("the script row", () => {
  it("shows the description as its target and streams the call trace while running", () => {
    render(
      <ToolCall name="script" args={ARGS} done={false} startedAt={Date.now()} toolCallId="s1" liveOutput={'▸ 1 glob src/*.txt\n✓ 1 8 ms · 14 lines\n▸ 2 grep "TODO"\n'} />,
    )
    expect(screen.getByText("Count TODOs per crate")).toBeTruthy()
    open()
    expect(screen.getByText("code")).toBeTruthy()
    expect(document.body.textContent).toContain("tools.glob")
    expect(screen.getByText("calls · 2")).toBeTruthy()
    const lines = [...document.querySelectorAll("[data-call-status]")].map((l) => l.getAttribute("data-call-status"))
    expect(lines).toEqual(["ok", "running"])
    expect(screen.queryByText("result")).toBeNull()
  })

  it("rebuilds the same row from the stored result after a reload", async () => {
    stored = RESULT
    useAgentStore.setState({ sessionId: "sess" })
    render(<ToolCall name="script" args={ARGS} done toolCallId="s2" resultBytes={RESULT.length} durationMs={1800} />)
    open()
    await waitFor(() => expect(screen.getByText("calls · 3")).toBeTruthy())
    const statuses = [...document.querySelectorAll("[data-call-status]")].map((l) => l.getAttribute("data-call-status"))
    expect(statuses).toEqual(["ok", "ok", "error"])
    expect(screen.getByText("error: path does not exist")).toBeTruthy()
    expect(document.body.textContent).toContain('[ ["agent", 11] ]')
    expect(document.querySelector("[data-script-summary]")?.textContent).toBe("3 calls · saved as count-todos")
  })

  it("names a saved script it runs, and notes a stop at the time limit", () => {
    const args = JSON.stringify({ name: "count-todos", args: { pattern: "FIXME" } })
    const result = "calls (1, 270.0 s):\n→ shell sleep 999 · cancelled\noutput:\nwaiting\nerror: stopped after 270 s, the time limit of a script"
    render(<ToolCall name="script" args={args} done toolCallId="s3" result={result} durationMs={270000} />)
    expect(screen.getByText('count-todos {"pattern":"FIXME"}')).toBeTruthy()
    open()
    expect(screen.getByText("code · saved script count-todos")).toBeTruthy()
    expect(screen.getByRole("note").textContent).toContain("time limit")
    expect(document.querySelector('[data-call-status="cancelled"]')).toBeTruthy()
    expect(document.querySelector("[data-script-summary]")?.textContent).toBe("1 call · stopped")
  })
})
