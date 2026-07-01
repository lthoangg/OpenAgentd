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
})
