import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { ReadView } from "@/components/ToolCall/ReadView"

afterEach(cleanup)

describe("ReadView", () => {
  it("truncates very large read bodies for display", () => {
    render(
      <ReadView
        args={JSON.stringify({ path: "src/large.txt" })}
        result={`first-${"x".repeat(20_000)}-last`}
      />,
    )

    expect(screen.getByText(/display truncated/)).toBeTruthy()
    expect(screen.getByText(/first-/)).toBeTruthy()
    expect(screen.getByText(/-last/)).toBeTruthy()
  })

  // Regression: the body sits inside a Collapsible grid that grows to its
  // content, so a height cap on the outer card clipped the body instead of
  // letting it scroll. The scroll body must carry its own height cap.
  it("caps the height of the scroll body itself so long results scroll", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")
    render(<ReadView args={JSON.stringify({ path: "src/long.txt" })} result={`[1-200/200]\n${body}`} />)

    const scroller = screen.getByText("line 1").closest(".overflow-y-auto") as HTMLElement | null
    expect(scroller).toBeTruthy()
    expect(scroller!.className).toMatch(/(^|\s)max-h-\S+/)
    expect(scroller!.className).toMatch(/(^|\s)sm:max-h-\S+/)
  })

  it("shows a skeleton, not the word, while the lines load", () => {
    render(<ReadView args={JSON.stringify({ path: "src/app.ts" })} loading />)
    expect(screen.getByRole("status", { name: "Loading lines" }).getAttribute("data-slot")).toBe("skeleton")
    expect(screen.queryByText("Loading…")).toBeNull()
  })

  it("shows no numbered empty line while the lines load", () => {
    const { container } = render(<ReadView args={JSON.stringify({ path: "src/app.ts" })} loading />)
    expect(screen.queryByText("1")).toBeNull()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(1)
  })

  it("shows the loading lines in a fill the header itself does not use", () => {
    render(<ReadView args={JSON.stringify({ path: "src/app.ts" })} loading />)
    // The header is filled with --bg-key; a skeleton in that fill is invisible.
    expect(screen.getByRole("status", { name: "Loading lines" }).className).not.toContain("bg-(--bg-key)")
  })
})
