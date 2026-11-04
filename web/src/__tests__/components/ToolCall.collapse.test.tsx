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
