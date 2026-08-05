/**
 * Performance regression: `DiffView` must not recompute its diff derivation
 * on every render.
 *
 * `ToolCall` runs a 1s `setInterval` while a tool is still executing, purely
 * to redraw the elapsed-duration label. `DiffView` used to call `diffLines`
 * (an O(oldLines*newLines) LCS) and `parsePatchText` directly in its render
 * body, so each of those ticks re-ran the whole derivation for the entire
 * lifetime of the tool call. On a 2000-line edit that measured ~29ms and
 * ~31MB of matrix allocation *per second* on the main thread.
 *
 * Sibling of `ToolCall.perf.test.tsx`, which guards the same property for
 * `getToolDisplay` / `getDiffStats`.
 */
import { describe, it, expect, afterEach, beforeEach, spyOn } from "bun:test"
import { act, render, cleanup } from "@testing-library/react"
import { ToolCall } from "@/components/ToolCall"
import { DiffView } from "@/components/ToolCall/DiffView"
import * as diffUtilsModule from "@/components/ToolCall/diffUtils"

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

// Deterministic fake timers — same pattern as ToolCall.perf.test.tsx.
function useFakeTimers() {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realDateNow = Date.now
  let now = 0
  let sequence = 0
  const timers = new Map<number, { callback: () => void; interval: number; due: number }>()

  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    const id = ++sequence
    timers.set(id, { callback: callback as () => void, interval: delay ?? 0, due: now + (delay ?? 0) })
    return id as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: number) => { timers.delete(id) }) as typeof clearInterval
  Date.now = () => now

  return {
    tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timer.due += timer.interval
          timer.callback()
          if (!timers.has(id)) continue
        }
      }
    },
    restore() {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      Date.now = realDateNow
    },
  }
}

describe("DiffView — perf: memoized diff derivation", () => {
  it("does not recompute diffLines on elapsed-timer ticks while an edit tool runs", () => {
    const spy = spyOn(diffUtilsModule, "diffLines")
    const timers = useFakeTimers()
    try {
      const args = JSON.stringify({
        path: "src/main.py",
        old_string: "old line\nsecond\nthird",
        new_string: "new line\nsecond\nthird",
      })
      // `liveOutput` makes the tool card default-expanded, so DiffView mounts.
      render(
        <ToolCall name="edit" args={args} done={false} startedAt={-1000} liveOutput="working..." />,
      )

      const afterMount = spy.mock.calls.length
      expect(afterMount).toBeGreaterThan(0)

      act(() => { timers.tick(1000) })
      act(() => { timers.tick(1000) })
      act(() => { timers.tick(1000) })

      expect(spy.mock.calls.length).toBe(afterMount)
    } finally {
      timers.restore()
      spy.mockRestore()
    }
  })

  it("does not recompute parsePatchText on elapsed-timer ticks while a patch tool runs", () => {
    const spy = spyOn(diffUtilsModule, "parsePatchText")
    const timers = useFakeTimers()
    try {
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/utils.py",
        "@@",
        "-old line",
        "+new line",
        "*** End Patch",
      ].join("\n")
      render(
        <ToolCall
          name="patch"
          args={JSON.stringify({ patch_text: patchText })}
          done={false}
          startedAt={-1000}
          liveOutput="working..."
        />,
      )

      const afterMount = spy.mock.calls.length
      expect(afterMount).toBeGreaterThan(0)

      act(() => { timers.tick(1000) })
      act(() => { timers.tick(1000) })

      expect(spy.mock.calls.length).toBe(afterMount)
    } finally {
      timers.restore()
      spy.mockRestore()
    }
  })

  it("recomputes when args actually change", () => {
    const spy = spyOn(diffUtilsModule, "diffLines")
    try {
      const mk = (newStr: string) =>
        JSON.stringify({ path: "src/main.py", old_string: "a", new_string: newStr })

      const { rerender } = render(<DiffView toolName="edit" args={mk("b")} />)
      const afterMount = spy.mock.calls.length

      rerender(<DiffView toolName="edit" args={mk("c")} />)
      expect(spy.mock.calls.length).toBeGreaterThan(afterMount)
    } finally {
      spy.mockRestore()
    }
  })

  it("does not recompute when re-rendered with identical args", () => {
    const spy = spyOn(diffUtilsModule, "diffLines")
    try {
      const args = JSON.stringify({
        path: "src/main.py",
        old_string: "a",
        new_string: "b",
      })

      const { rerender } = render(<DiffView toolName="edit" args={args} />)
      const afterMount = spy.mock.calls.length

      rerender(<DiffView toolName="edit" args={args} />)
      expect(spy.mock.calls.length).toBe(afterMount)
    } finally {
      spy.mockRestore()
    }
  })
})
