/**
 * useCompactRelative — a compact age (`now`, `5m`, `3h`, `2d`, `dd/MM`) that
 * keeps itself current.
 *
 * A label computed once at render froze: a sidebar row said `5m` for an hour,
 * because nothing re-rendered it. Every caller shares one 30-second clock that
 * runs only while something is subscribed, and a row re-renders only when its
 * own label changes (the snapshot is the string), not on every tick.
 * Returning to the tab updates the clock at once.
 */
import { useSyncExternalStore } from 'react'
import { formatCompactRelative } from '@/utils/format'

const TICK_MS = 30_000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function tick(): void {
  now = Date.now()
  for (const listener of listeners) listener()
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') tick()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // The clock idled while nobody listened; React re-reads the snapshot
    // after subscribing, so a stale first label corrects itself here.
    now = Date.now()
    timer = setInterval(tick, TICK_MS)
    document.addEventListener('visibilitychange', onVisibility)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    if (timer !== null) clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

export function useCompactRelative(dateStr: string | null | undefined): string {
  return useSyncExternalStore(
    subscribe,
    () => formatCompactRelative(dateStr, new Date(now)),
    () => formatCompactRelative(dateStr),
  )
}
