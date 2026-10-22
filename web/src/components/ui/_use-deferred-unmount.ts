/**
 * useDeferredUnmount — plays a CSS exit animation before unmounting.
 *
 * Returns `{ mounted, closing }`:
 *  - `mounted`  — whether to render the element at all
 *  - `closing`  — whether the exit animation is currently playing
 *
 * Usage:
 *   const { mounted, closing } = useDeferredUnmount(open, DURATIONS_S.fast * 1000)
 *   if (!mounted) return null
 *   <div className={closing ? 'animate-out animation-duration-(--motion-fast) ...' : 'animate-in ...'} />
 *
 * The duration (ms) must match the CSS animation duration, so pass a motion
 * token (design lint rejects a bare number).
 */
import { useEffect, useRef, useState } from 'react'
import { DURATIONS_S } from '@/lib/motion'

export function useDeferredUnmount(open: boolean, durationMs = DURATIONS_S.fast * 1000) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevOpenRef = useRef(open)

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open

    if (open) {
      setClosing(false)
      setMounted(true)
    } else if (wasOpen) {
      setClosing(true)
      timerRef.current = setTimeout(() => {
        setMounted(false)
        setClosing(false)
      }, durationMs)
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open, durationMs])

  return { mounted, closing }
}
