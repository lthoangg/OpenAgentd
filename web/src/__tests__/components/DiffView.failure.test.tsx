/**
 * Regression: a failed `patch` tool call must show its error, not a diff.
 *
 * `DiffView` used to derive its whole view from the *arguments* — the patch
 * envelope the model sent — with no regard for whether the tool actually
 * applied it. A rejected patch (bad context, ambiguous hunk, etc.) still
 * rendered the requested diff as if it had landed, and the +/- stat badge in
 * the collapsed header counted lines that were never written. See
 * `ToolCall.failure.test.tsx` for the sibling header-level regression.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
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

const PATCH_TEXT = [
  "*** Begin Patch",
  "*** Update File: src/utils.py",
  "@@",
  "-old line",
  "+new line",
  "*** End Patch",
].join("\n")

const ERROR_RESULT =
  "Error: Could not find patch context in src/utils.py.\nThe patch was looking for this block:\n  | old line"

describe("DiffView — failed patch call", () => {
  it("shows the error message instead of a fabricated diff", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall
        name="patch"
        args={JSON.stringify({ patch_text: PATCH_TEXT })}
        done={true}
        result={ERROR_RESULT}
      />,
    )

    await user.click(screen.getByRole("button"))

    expect(screen.getByText(/Could not find patch context/)).toBeTruthy()
    // Not rendered as an applied change — the line the model wanted removed
    // must not show up dressed as a "-old line" diff row.
    expect(screen.queryByText("old line")).toBeNull()
    expect(screen.queryByText("new line")).toBeNull()
  })

  it("hides the +/- stat badge in the collapsed header", () => {
    render(
      <ToolCall
        name="patch"
        args={JSON.stringify({ patch_text: PATCH_TEXT })}
        done={true}
        result={ERROR_RESULT}
      />,
    )

    expect(screen.queryByText("+1")).toBeNull()
    expect(screen.queryByText("-1")).toBeNull()
  })
})
