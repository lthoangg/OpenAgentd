/**
 * useDeferredUnmount — plays a CSS exit animation before unmounting.
 *
 * Returns `{ mounted, closing }`:
 *  - `mounted`  — whether to render the element at all
 *  - `closing`  — whether the exit animation is currently playing
 *
 * Usage:
 *   const { mounted, closing } = useDeferredUnmount(open, 150)
 *   if (!mounted) return null
 *   <div className={closing ? 'animate-out ...' : 'animate-in ...'} />
 *
 * The duration (ms) must match the CSS animation duration.
 */
import { useEffect, useRef, useState } from 'react'

export function useDeferredUnmount(open: boolean, durationMs = 150) {
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
