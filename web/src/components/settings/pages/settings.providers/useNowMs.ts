import { useEffect, useState } from 'react'

/**
 * The current time, as state, refreshed every `stepMs` while `until` is unset
 * or still ahead. Callers compute from the returned value (never from
 * `Date.now()` in render), so the output depends on state and cannot be frozen
 * by memoisation that only looks at their other inputs.
 */
export function useNowMs(active: boolean, stepMs: number, until?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (until !== undefined && t >= until) window.clearInterval(id)
    }, stepMs)
    return () => window.clearInterval(id)
  }, [active, stepMs, until])
  return now
}
