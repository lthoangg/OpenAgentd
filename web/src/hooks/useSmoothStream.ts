import { useEffect, useState, useRef } from 'react'

/**
 * A hook that takes a fast or chunky streaming string and smoothly interpolates
 * it over time, creating a typewriter-like effect that adapts to the stream speed.
 *
 * Uses a self-contained rAF loop with functional setState so that a single
 * effect handles the entire animation without triggering a re-render per frame.
 *
 * @param targetText The actual text content from the stream
 * @param isStreaming Whether the stream is currently active
 * @returns The smoothed text content to display
 */
export function useSmoothStream(targetText: string, isStreaming: boolean): string {
  const [displayedText, setDisplayedText] = useState(targetText)
  const targetRef = useRef(targetText)
  targetRef.current = targetText

  const displayedLengthRef = useRef(targetText.length)

  useEffect(() => {
    // Not streaming: always show the real text immediately.
    if (!isStreaming) {
      setDisplayedText(targetText)
      displayedLengthRef.current = targetText.length
      return
    }

    // Streaming but target is not a forward extension of what we already show:
    // snap immediately (e.g. message replaced / different session).
    setDisplayedText((prev) => {
      if (!targetText.startsWith(prev)) {
        displayedLengthRef.current = targetText.length
        return targetText
      }
      displayedLengthRef.current = prev.length
      return prev
    })

    let frameId: number
    let active = true
    let lastUpdateTime = 0

    const loop = (time?: number) => {
      if (!active) return
      const timestamp = time || performance.now()

      const currentLength = displayedLengthRef.current
      let throttleMs = 0
      // Adaptive throttling: decrease rendering frequency as document length grows
      // to reduce markdown parsing CPU/rendering overhead.
      if (currentLength > 10000) {
        throttleMs = 150
      } else if (currentLength > 5000) {
        throttleMs = 75
      } else if (currentLength > 2000) {
        throttleMs = 35
      }

      if (timestamp - lastUpdateTime >= throttleMs) {
        setDisplayedText((prev) => {
          const target = targetRef.current
          // If target changed to something that is no longer an extension, snap.
          if (!target.startsWith(prev)) {
            displayedLengthRef.current = target.length
            return target
          }

          const diff = target.length - prev.length
          if (diff <= 0) return prev

          // Add at least 1 char, up to 15% of the remaining distance per frame.
          // Scale step up if we are throttling to maintain smooth catch-up speed.
          const multiplier = throttleMs > 0 ? Math.min(0.5, 0.15 * (throttleMs / 16.67)) : 0.15
          const step = Math.max(1, Math.ceil(diff * multiplier))
          const nextText = target.slice(0, prev.length + step)
          displayedLengthRef.current = nextText.length
          return nextText
        })
        lastUpdateTime = timestamp
      }

      frameId = requestAnimationFrame(loop)
    }

    frameId = requestAnimationFrame(loop)

    return () => {
      active = false
      cancelAnimationFrame(frameId)
    }
  }, [isStreaming, targetText])

  return isStreaming ? displayedText : targetText
}
