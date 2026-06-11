import { describe, it, expect, afterEach, mock } from "bun:test"
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react"
import { ReadView } from "@/components/ToolCall/ReadView"

afterEach(cleanup)

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: mock(async () => {}) },
  configurable: true,
})

describe("ReadView", () => {
  it("clears pending copy feedback timers on unmount", async () => {
    const originalClearTimeout = window.clearTimeout
    const clearTimeout = mock((...args: unknown[]) => originalClearTimeout(args[0] as number | undefined))
    window.clearTimeout = clearTimeout as typeof window.clearTimeout

    try {
      const view = render(
        <ReadView
          args={JSON.stringify({ path: "src/main.py" })}
          result={"[42-42/100]\nconst value = 'long line'"}
        />,
      )

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Copy read result"))
        await Promise.resolve()
      })
      view.unmount()

      expect(clearTimeout).toHaveBeenCalledTimes(1)
    } finally {
      window.clearTimeout = originalClearTimeout
    }
  })

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
