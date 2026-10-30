/**
 * Long open tool details end with a "Collapse" row, so closing them does not
 * mean scrolling back to the header. Short details do not get one.
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

describe("ToolCall — Collapse row", () => {
  it("ends long details with a Collapse row that closes them", async () => {
    const user = userEvent.setup()
    const longResult = Array.from({ length: 20 }, (_, i) => `match ${i + 1}`).join("\n")
    render(<ToolCall name="grep" args={JSON.stringify({ pattern: "useSession" })} done={true} result={longResult} />)

    await user.click(screen.getByRole("button", { name: "Expand grep details" }))
    await user.click(screen.getByRole("button", { name: "Collapse" }))
    expect(screen.getByRole("button", { name: "Expand grep details" }).getAttribute("aria-expanded")).toBe("false")
  })

  it("leaves short details without one", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="grep" args={JSON.stringify({ pattern: "useSession" })} done={true} result={"one\ntwo"} />)

    await user.click(screen.getByRole("button", { name: "Expand grep details" }))
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull()
  })
})
