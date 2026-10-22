/**
 * Deterministic ``setTimeout`` for tests that step through a motion's
 * timed unmount (Bun has no jest-style fake timer API). Under the parallel
 * run, real timers can lag by seconds; stepping them keeps exit-motion tests
 * exact. Wrap ``tick`` in ``act`` when the callbacks update React state.
 */
export function useFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let now = 0
  let sequence = 0
  const timers = new Map<number, { callback: () => void; due: number }>()
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = ++sequence
    timers.set(id, { callback: callback as () => void, due: now + (delay ?? 0) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id)
  }) as typeof clearTimeout
  return {
    /** Advance the clock, running every timer that falls due (and any they schedule). */
    tick(ms: number) {
      const until = now + ms
      for (;;) {
        const next = [...timers].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        timers.delete(next[0])
        now = Math.max(now, next[1].due)
        next[1].callback()
      }
      now = until
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}
