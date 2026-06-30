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

  useEffect(() => {
    // Not streaming: always show the real text immediately.
    if (!isStreaming) {
      setDisplayedText(targetText)
      return
    }

    // Streaming but target is not a forward extension of what we already show:
    // snap immediately (e.g. message replaced / different session).
    setDisplayedText((prev) => {
      if (!targetText.startsWith(prev)) return targetText
      return prev
    })

    let frameId: number
    let active = true

    const loop = () => {
      if (!active) return

      setDisplayedText((prev) => {
        const target = targetRef.current
        // If target changed to something that is no longer an extension, snap.
        if (!target.startsWith(prev)) return target

        const diff = target.length - prev.length
        if (diff <= 0) return prev

        // Add at least 1 char, up to 15% of the remaining distance per frame.
        const step = Math.max(1, Math.ceil(diff * 0.15))
        return target.slice(0, prev.length + step)
      })

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
