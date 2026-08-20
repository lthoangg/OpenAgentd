/**
 * Regression: a completed tool call that failed must read as failed in the
 * *collapsed* header, not only inside the expanded result body.
 *
 * `isFailedResult` recognised only the shell tool's bracketed vocabulary
 * (`[Failed ...]`, `[Timed out ...]`) — every other tool funnels a raised
 * exception through `sanitize_error` as a plain `"Error: ..."` string (see
 * `app/agent/agent_loop/tool_executor.py`), which matched none of those
 * prefixes. On top of that, the header's only state-dependent styling was
 * the running-state pulse; a finished call carried no colour distinction
 * between "succeeded" and "failed" at all. Together, a failed `patch` (or
 * any other non-shell tool) call looked identical to a successful one
 * unless the user expanded it and read the body text.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { ToolCall } from "@/components/ToolCall"

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

/** The header span carries the state-driven colour class; find it by its `title`. */
function getHeaderSpan(container: HTMLElement): HTMLElement {
  const span = container.querySelector("button > span[title]")
  if (!(span instanceof HTMLElement)) throw new Error("header span not found")
  return span
}

describe("ToolCall — failure indication", () => {
  it("colors the collapsed header as an error for a generic tool's 'Error: ...' result", () => {
    const { container } = render(
      <ToolCall
        name="patch"
        args={JSON.stringify({ patch_text: "*** Begin Patch\n*** End Patch" })}
        done={true}
        result="Error: Could not find patch context in src/utils.py."
      />,
    )

    expect(getHeaderSpan(container).className).toContain("color-error")
  })

  it("colors the collapsed header as an error for a shell [Failed] result", () => {
    const { container } = render(
      <ToolCall
        name="shell"
        args={JSON.stringify({ command: "pytest" })}
        done={true}
        result={"[Failed — exit code 1]\n\nAssertionError"}
      />,
    )

    expect(getHeaderSpan(container).className).toContain("color-error")
  })

  it("does not color the collapsed header as an error on success", () => {
    const { container } = render(
      <ToolCall
        name="patch"
        args={JSON.stringify({ patch_text: "*** Begin Patch\n*** End Patch" })}
        done={true}
        result="Patch applied successfully. Updated paths:\nsrc/utils.py"
      />,
    )

    expect(getHeaderSpan(container).className).not.toContain("color-error")
  })
})
