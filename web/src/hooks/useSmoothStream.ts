import { useEffect, useState, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

/**
 * The most text that still flows in after the stream ends. A larger gap (an
 * answer that finished while the window was hidden, a history reload) is
 * shown at once: revealing it would only hold the reader back.
 */
const MAX_DRAIN_CHARS = 4000

/**
 * A hook that takes a fast or chunky streaming string and smoothly interpolates
 * it over time, creating a typewriter-like effect that adapts to the stream speed.
 *
 * Uses a self-contained rAF loop with functional setState so that a single
 * effect handles the entire animation without triggering a re-render per frame.
 *
 * When the stream ends while text is still being revealed (the last delta
 * usually lands with "done"), the rest keeps flowing at the same pace
 * instead of appearing in one frame; the caller can tell from the returned
 * text differing from ``targetText`` that it is still settling. Text that was
 * never streamed, and reduced motion, show at once.
 *
 * @param targetText The actual text content from the stream
 * @param isStreaming Whether the stream is currently active
 * @returns The smoothed text content to display
 */
export function useSmoothStream(targetText: string, isStreaming: boolean): string {
  const [displayedText, setDisplayedText] = useState(targetText)
  // Whether this text has streamed since it last settled: only then may the
  // end keep flowing. Reset once the reveal catches up, so a later edit of a
  // finished message shows at once.
  const [streamed, setStreamed] = useState(isStreaming)
  if (isStreaming && !streamed) setStreamed(true)

  const draining = !isStreaming
    && streamed
    && displayedText !== targetText
    && targetText.startsWith(displayedText)
    && targetText.length - displayedText.length <= MAX_DRAIN_CHARS
    && !prefersReducedMotion()

  const targetRef = useRef(targetText)
  const displayedLengthRef = useRef(targetText.length)
  // Outlives the effect: it re-runs on every delta (~16 ms), and a clock local
  // to it reset on each run, so the throttle never held between deltas.
  const lastUpdateTimeRef = useRef(0)

  useEffect(() => {
    targetRef.current = targetText
    // Not streaming and nothing left to flow: show the real text.
    if (!isStreaming && !draining) {
      setDisplayedText(targetText)
      displayedLengthRef.current = targetText.length
      if (streamed) setStreamed(false)
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

      if (timestamp - lastUpdateTimeRef.current >= throttleMs) {
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
        lastUpdateTimeRef.current = timestamp
      }

      // Nothing left to animate — stop asking for frames. Re-arming
      // unconditionally kept a 60fps loop alive over already-settled text
      // until some unrelated re-render happened to tear the effect down;
      // traced at 172 frames for a single message. The effect re-arms on the
      // next `targetText` change, which is the only thing that creates work.
      //
      // `displayedLengthRef` is written inside the state updater, which React
      // may run after this line; a stale (short) read just costs one extra
      // frame before the loop settles.
      if (displayedLengthRef.current >= targetRef.current.length) return

      frameId = requestAnimationFrame(loop)
    }

    frameId = requestAnimationFrame(loop)

    return () => {
      active = false
      cancelAnimationFrame(frameId)
    }
    // ``draining`` turns false when the reveal catches up, which re-runs this
    // to settle; ``streamed`` is only read on that settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, targetText, draining])

  return isStreaming || draining ? displayedText : targetText
}
