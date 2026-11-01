/**
 * One shared once-a-second clock for live elapsed labels (running tool rows,
 * running subagent rows, reader mode's work row), paused while the page is
 * hidden. Lives apart from ``ToolCall/index.tsx`` so ``ToolResult`` can use
 * it without importing the module that imports it.
 */

let liveClockInterval: number | null = null
let liveClockTick: (() => void) | null = null
const liveClockListeners = new Set<(now: number) => void>()

/**
 * Subscribe to the clock; returns the unsubscribe. The interval stops with
 * its last listener.
 */
export function subscribeLiveClock(listener: (now: number) => void) {
  liveClockListeners.add(listener)
  if (liveClockInterval === null && typeof window !== 'undefined') {
    liveClockTick = () => {
      if (typeof document === 'undefined' || !document.hidden) {
        const timestamp = Date.now()
        liveClockListeners.forEach((fn) => fn(timestamp))
      }
    }
    liveClockInterval = window.setInterval(liveClockTick, 1000)
    document.addEventListener('visibilitychange', liveClockTick)
  }
  return () => {
    liveClockListeners.delete(listener)
    if (liveClockListeners.size === 0 && liveClockInterval !== null) {
      window.clearInterval(liveClockInterval)
      liveClockInterval = null
      if (liveClockTick) document.removeEventListener('visibilitychange', liveClockTick)
      liveClockTick = null
    }
  }
}
