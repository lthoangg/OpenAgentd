import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { ReadView } from "@/components/ToolCall/ReadView"

afterEach(cleanup)

describe("ReadView", () => {
  it("keeps read line numbers sticky during horizontal scroll", () => {
    render(
      <ReadView
        args={JSON.stringify({ path: "src/main.py" })}
        result={"[42-42/100]\nconst value = 'long line'"}
      />,
    )

    const gutterClassName = screen.getByText('42').parentElement?.className ?? ''
    expect(gutterClassName).toContain('sticky left-0')
    expect(gutterClassName).toContain('bg-(--bg-input)')
  })

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
})

// ---------------------------------------------------------------------------
// Background bleed regression — ReadView's outer div and content div must not
// carry border-radius that creates a gap against the outer overflow-hidden
// section.
// ---------------------------------------------------------------------------

describe("ReadView — no redundant inner border-radius (bg-bleed regression)", () => {
  it("outer flex container has no rounded-sm", () => {
    render(
      <ReadView
        args={JSON.stringify({ path: "src/foo.ts" })}
        result="[1-1/1]\nconsole.log('hi')"
      />,
    )

    // The outermost div rendered by ReadView must not carry rounded-sm —
    // the parent section already handles rounding via overflow:hidden.
    const outerDiv = document.querySelector(".flex.max-h-80.flex-col.overflow-hidden")
    expect(outerDiv).not.toBeNull()
    expect(outerDiv!.className).not.toContain("rounded-sm")
  })

  it("content area has no rounded-b-sm", () => {
    render(
      <ReadView
        args={JSON.stringify({ path: "src/foo.ts" })}
        result="[1-2/2]\nline one\nline two"
      />,
    )

    const contentArea = document.querySelector(".overflow-y-auto.bg-\\(--bg-input\\)")
    expect(contentArea).not.toBeNull()
    expect(contentArea!.className).not.toContain("rounded-b-sm")
  })

  it("header bar has no sticky positioning or rounded-t-sm", () => {
    render(
      <ReadView
        args={JSON.stringify({ path: "src/bar.ts" })}
        result="[1-1/1]\nconst x = 1"
      />,
    )

    // The parent already clips the header; avoid sticky positioning here because
    // Tauri WebViews can paint the body before the sticky header text settles.
    const header = screen.getByRole("button", { name: "Collapse read result" }).parentElement
    expect(header).not.toBeNull()
    expect(header!.className).not.toContain("sticky")
    expect(header!.className).not.toContain("top-0")
    expect(header!.className).not.toContain("rounded-t-sm")
  })
})
