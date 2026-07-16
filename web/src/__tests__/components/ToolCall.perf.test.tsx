/**
 * Performance regression: `getToolDisplay` / `getDiffStats` must not be
 * recomputed on every render while a tool is "running" — specifically not
 * on every elapsed-timer tick driven by `ToolCall`'s internal
 * `setInterval`. Both derivations are pure functions of `(name, args,
 * result)`; recomputing them on an unrelated timer tick wastes CPU (full
 * JSON.parse + an O(oldLines*newLines) diff for edit/patch/write tools)
 * for the entire lifetime of a running tool call purely to redraw a
 * "3.2s" duration label.
 */
import { describe, it, expect, afterEach, beforeEach, spyOn } from "bun:test"
import { act, render, cleanup } from "@testing-library/react"
import { ToolCall } from "@/components/ToolCall"
import * as displayModule from "@/components/ToolCall/display"
import * as diffUtilsModule from "@/components/ToolCall/diffUtils"

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

// Deterministic fake timers — same pattern as ToastStack.test.tsx /
// App.bootstrap.test.tsx (Bun's test runner has no jest-style fake timers).
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
    intervals() {
      return [...timers.values()].map((timer) => timer.interval)
    },
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

describe("ToolCall — perf: memoized display/diff derivation", () => {
  it("updates the elapsed label at most once per second", () => {
    const timers = useFakeTimers()
    try {
      render(<ToolCall name="shell" args='{"command":"bun test"}' done={false} startedAt={-1000} />)

      expect(timers.intervals()).toContain(1000)
      expect(timers.intervals()).not.toContain(100)
    } finally {
      timers.restore()
    }
  })

  it("does not recompute getToolDisplay on every elapsed-timer tick while running", () => {
    const spy = spyOn(displayModule, "getToolDisplay")
    const timers = useFakeTimers()
    try {
      const args = JSON.stringify({ path: "src/main.py" })
      render(<ToolCall name="read" args={args} done={false} startedAt={-1000} />)

      const callsAfterMount = spy.mock.calls.length
      expect(callsAfterMount).toBeGreaterThan(0)

      // Advance one elapsed-timer tick without any prop change — only the
      // internal `now` state changes to redraw the duration label.
      act(() => { timers.tick(1000) })

      // The memoized derivation must not scale with unrelated re-renders.
      expect(spy.mock.calls.length).toBe(callsAfterMount)
    } finally {
      timers.restore()
      spy.mockRestore()
    }
  })

  it("does not recompute getDiffStats on every elapsed-timer tick while an edit tool is running", () => {
    const spy = spyOn(diffUtilsModule, "getDiffStats")
    const timers = useFakeTimers()
    try {
      const args = JSON.stringify({
        path: "src/main.py",
        old_string: "old line",
        new_string: "new line",
      })
      render(<ToolCall name="edit" args={args} done={false} startedAt={-1000} />)

      const callsAfterMount = spy.mock.calls.length
      expect(callsAfterMount).toBeGreaterThan(0)

      act(() => { timers.tick(1000) })

      expect(spy.mock.calls.length).toBe(callsAfterMount)
    } finally {
      timers.restore()
      spy.mockRestore()
    }
  })
})
