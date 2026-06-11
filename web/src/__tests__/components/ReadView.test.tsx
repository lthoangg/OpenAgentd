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
    expect(gutterClassName).toContain('bg-(--bg-card)')
  })
})
