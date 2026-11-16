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

/**
 * Real timers a test can run early. For a component's grace period (the
 * second or more it waits before it decides something), where the test wants
 * what happens after the wait and not the wait itself: ``skip(3000)`` runs,
 * in due order, every held timer that falls due in the next 3 s, and any
 * they schedule within it.
 *
 * Unlike ``useFakeTimers``, a timer nobody skips still fires on time, so
 * ``waitFor`` keeps its own timeout and a failing test fails with its
 * message. Only timers of ``atLeast`` ms or longer are held; shorter ones are
 * left alone. Wrap ``skip`` in ``act`` when the callbacks update React state.
 */
export function useSkippableTimers({ atLeast }: { atLeast: number }) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  // How far skips have moved the test's clock ahead of the real one.
  let ahead = 0
  const now = () => performance.now() + ahead
  type Held = { callback: () => void; due: number; real: ReturnType<typeof realSetTimeout> }
  const held = new Map<object, Held>()
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const run = () => (callback as (...a: unknown[]) => void)(...args)
    if ((delay ?? 0) < atLeast) return realSetTimeout(run, delay)
    const real = realSetTimeout(() => {
      held.delete(real as object)
      run()
    }, delay)
    held.set(real as object, { callback: run, due: now() + (delay ?? 0), real })
    return real
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof realSetTimeout>) => {
    held.delete(id as object)
    realClearTimeout(id)
  }) as typeof clearTimeout
  return {
    /** Run now every held timer due within `ms`, earliest first. */
    skip(ms: number) {
      const until = now() + ms
      for (;;) {
        const next = [...held].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        held.delete(next[0])
        realClearTimeout(next[1].real)
        // A timer the callback schedules counts from this one's due time.
        ahead = Math.max(ahead, next[1].due - performance.now())
        next[1].callback()
      }
      ahead = Math.max(ahead, until - performance.now())
    },
    restore() {
      for (const timer of held.values()) realClearTimeout(timer.real)
      held.clear()
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}
