import { useEffect, useState, useRef } from 'react'

/**
 * A hook that takes a fast or chunky streaming string and smoothly interpolates
 * it over time, creating a typewriter-like effect that adapts to the stream speed.
 *
 * @param targetText The actual text content from the stream
 * @param isStreaming Whether the stream is currently active
 * @returns The smoothed text content to display
 */
export function useSmoothStream(targetText: string, isStreaming: boolean): string {
  const [displayedText, setDisplayedText] = useState(targetText)
  const targetRef = useRef(targetText)
  targetRef.current = targetText

  // If streaming is turned off, immediately sync and stop animating.
  // Also, if the targetText is completely different or shorter, sync immediately.
  useEffect(() => {
    if (!isStreaming || !targetText.startsWith(displayedText)) {
      setDisplayedText(targetText)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, targetText])

  useEffect(() => {
    if (!isStreaming) return
    if (displayedText.length >= targetText.length) return

    let active = true

    const stepAnimation = () => {
      if (!active) return

      const target = targetRef.current
      const currentLen = displayedText.length
      const diff = target.length - currentLen

      if (diff > 0) {
        // Smoothly interpolate: add at least 1 character, up to 15% of the remaining text.
        // This makes large chunks sweep in smoothly, while small/fast chunks keep up.
        const step = Math.max(1, Math.ceil(diff * 0.15))
        const nextLen = currentLen + step
        const nextText = target.slice(0, nextLen)
        setDisplayedText(nextText)
      }
    }

    const frameId = requestAnimationFrame(stepAnimation)

    return () => {
      active = false
      cancelAnimationFrame(frameId)
    }
  }, [isStreaming, targetText, displayedText])

  return isStreaming ? displayedText : targetText
}
