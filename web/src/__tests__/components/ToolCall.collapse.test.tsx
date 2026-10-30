/**
 * Open tool details have no bottom "Collapse" bar: the pinned tool row (and
 * the section captions) close them.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ToolCall } from "@/components/ToolCall"

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

describe("ToolCall — closing details", () => {
  it("keeps the result summary readable and lets the target truncate instead", () => {
    render(<ToolCall name="grep" args={JSON.stringify({ pattern: "a-very-long-pattern-that-fills-a-phone-row" })} done={true} result={"src/a.ts:1:x\nsrc/b.ts:2:y"} />)

    const summary = screen.getByText("2 matches in 2 files")
    // The summary keeps its own width (up to 60% of the row); the target gives way.
    expect(summary.className).toContain("shrink-0")
    expect(summary.className).toContain("max-w-[60%]")
  })

  it("ends long details without a Collapse bar", async () => {
    const user = userEvent.setup()
    const longResult = Array.from({ length: 20 }, (_, i) => `match ${i + 1}`).join("\n")
    render(<ToolCall name="grep" args={JSON.stringify({ pattern: "useSession" })} done={true} result={longResult} />)

    await user.click(screen.getByRole("button", { name: "Expand grep details" }))
    expect(screen.getByText(/match 20/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull()
  })

  it("closes long details from the tool row", async () => {
    const user = userEvent.setup()
    const longResult = Array.from({ length: 20 }, (_, i) => `match ${i + 1}`).join("\n")
    render(<ToolCall name="grep" args={JSON.stringify({ pattern: "useSession" })} done={true} result={longResult} />)

    await user.click(screen.getByRole("button", { name: "Expand grep details" }))
    await user.click(screen.getByRole("button", { name: "Collapse grep details" }))
    expect(screen.getByRole("button", { name: "Expand grep details" }).getAttribute("aria-expanded")).toBe("false")
  })
})
