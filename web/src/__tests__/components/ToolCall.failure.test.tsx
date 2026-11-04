/**
 * Tool rows are a quiet record: no result summary, no exit chip, no red
 * failure mark on the collapsed row. Most results no longer travel with the
 * history at all (they load when the row is opened), so the row cannot judge
 * success; a failure shows only in the opened body.
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

/** The row's red result summary: the span holding `text`, if it is error-coloured. */
function errorSummary(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("button span"))
    .find((span) => span.textContent === text && span.className.includes("text-(--color-error)"))
}

function toolName(container: HTMLElement, name: string): HTMLElement {
  const span = Array.from(container.querySelectorAll<HTMLElement>("button span"))
    .find((node) => node.textContent === name)
  if (!span) throw new Error(`tool name "${name}" not found`)
  return span
}

function chip(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="chip"]')
}

describe("ToolCall — failure indication", () => {
  it("keeps a failed patch row neutral: no red summary, no error chip", () => {
    const { container } = render(
      <ToolCall
        name="patch"
        args={JSON.stringify({ patch_text: "*** Begin Patch\n*** End Patch" })}
        done={true}
        result="Error: Could not find patch context in src/utils.py."
      />,
    )

    expect(errorSummary(container, "Could not find patch context in src/utils.py.")).toBeUndefined()
    expect(chip(container)).toBeNull()
    expect(toolName(container, "patch").className).not.toContain("color-error")
  })

  it("shows no exit chip and no red summary for a shell [Failed] result", () => {
    const { container } = render(
      <ToolCall
        name="shell"
        args={JSON.stringify({ command: "pytest" })}
        done={true}
        result={"[Failed — exit code 1]\n\nAssertionError"}
      />,
    )

    expect(errorSummary(container, "AssertionError")).toBeUndefined()
    expect(container.querySelector("button .text-\\(--color-error\\)")).toBeNull()
    expect(chip(container)).toBeNull()
    expect(toolName(container, "shell").className).not.toContain("color-error")
  })

  it("shows no chip for a timed-out shell call", () => {
    const { container } = render(
      <ToolCall name="shell" args={JSON.stringify({ command: "sleep 999" })} done={true} result={"[Timed out after 120s]\n\npartial"} />,
    )

    expect(chip(container)).toBeNull()
    expect(container.querySelector("button .text-\\(--color-error\\)")).toBeNull()
  })

  it("shows no test-count summary on a shell row", () => {
    const { container } = render(
      <ToolCall name="shell" args={JSON.stringify({ command: "bun test" })} done={true} result={"[Failed — exit code 1]\n\n 1 fail\n 11 pass"} />,
    )

    const summary = Array.from(container.querySelectorAll<HTMLElement>("button span")).find((s) => s.textContent === "1 failed, 11 passed")
    expect(summary).toBeUndefined()
  })

  it("shows no error styling or error chip on success", () => {
    const { container } = render(
      <ToolCall
        name="patch"
        args={JSON.stringify({ patch_text: "*** Begin Patch\n*** End Patch" })}
        done={true}
        result="Patch applied successfully. Updated paths:\nsrc/utils.py"
      />,
    )

    expect(container.querySelector("button .text-\\(--color-error\\)")).toBeNull()
    expect(chip(container)).toBeNull()
  })

  it("shows no exit chip for a successful shell call", () => {
    const { container } = render(
      <ToolCall
        name="shell"
        args={JSON.stringify({ command: "true" })}
        done={true}
        result={"[Succeeded]\n\nok"}
      />,
    )

    expect(chip(container)).toBeNull()
    expect(container.querySelector("button .text-\\(--color-error\\)")).toBeNull()
  })
})
