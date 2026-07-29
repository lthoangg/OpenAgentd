/**
 * Textarea autosize state for InputBar — height-to-content resizing capped at
 * ``MAX_TEXTAREA_HEIGHT``, plus the single/multi-line layout flag that wraps
 * the action buttons onto a second row.
 *
 * Kept in a separate module (not `.tsx`) so InputBar.tsx stays HMR-friendly
 * under react-refresh and its render tree stays focused on layout/markup.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Height cap in px. Must match the textarea's inline ``maxHeight`` style. */
export const MAX_TEXTAREA_HEIGHT = 120

export function useTextareaAutosize(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  // ``isMultiLine`` is updated as a side-effect of ``resize`` rather
  // than a separate effect, so the DOM measurement and the React
  // state stay in lock-step (one render cycle, no cascade).
  //
  // Hysteresis on the promote/demote decision:
  //   - Promote (false → true): textarea's scrollHeight exceeds one
  //     line height. Record the value length at the moment of
  //     promotion in ``promoteLengthRef``.
  //   - Demote (true → false): only when the value has no newlines
  //     AND its length is now ≤ 80% of the recorded promote-length.
  //     The 20% guard band absorbs the layout feedback loop where
  //     promoting widens the textarea (so the same content fits on
  //     one line again) which would otherwise demote → re-promote.
  const [isMultiLine, setIsMultiLine] = useState(false)
  const promoteLengthRef = useRef(0)
  const lineHeightRef = useRef<number | null>(null)
  const resizeFrameRef = useRef<number | null>(null)

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const scrollHeight = el.scrollHeight
    el.style.height = `${Math.min(scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
    let lineHeight = lineHeightRef.current
    if (lineHeight == null) {
      const computed = window.getComputedStyle(el)
      lineHeight = parseFloat(computed.lineHeight) ||
        parseFloat(computed.fontSize) * 1.5
      lineHeightRef.current = lineHeight
    }
    const wrapped = scrollHeight > lineHeight * 1.4
    const currentLen = el.value.length
    const hasNewline = el.value.includes('\n')

    setIsMultiLine((prev) => {
      if (!prev && wrapped) {
        // Promote: remember the length so we know when it's safe to
        // demote later.
        promoteLengthRef.current = currentLen
        return true
      }
      if (prev && !wrapped && !hasNewline) {
        // Demote candidate. Only commit if length has dropped clearly
        // below the promote-length (80% threshold) — guards against
        // the wrap-promote-rewrap loop in the boundary band.
        const demoteThreshold = Math.floor(promoteLengthRef.current * 0.8)
        if (currentLen <= demoteThreshold) {
          promoteLengthRef.current = 0
          return false
        }
      }
      return prev
    })
  }, [textareaRef])

  /** Coalesce per-keystroke resize requests into one rAF-batched measure. */
  const scheduleResize = useCallback(() => {
    if (resizeFrameRef.current != null) return
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null
      resize()
    })
  }, [resize])

  useEffect(() => {
    return () => {
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current)
    }
  }, [])

  // Recalculate the textarea height after the browser's next layout pass.
  // Double-rAF: the outer frame fires after React's paint; the inner frame
  // fires after the browser's subsequent layout pass, by which point any
  // parent expand animation (e.g. FloatingInputBar minimized→expanded
  // Framer spring) has had a frame to reach its final width. Measuring
  // scrollHeight at the wrong narrow width would lock the textarea at
  // 1-line height. Runs ``andThen`` after the resize; returns a cancel
  // function for effects that may re-fire before the frames elapse.
  const resizeAfterLayout = useCallback((andThen?: () => void): (() => void) => {
    let innerId = 0
    const outerId = requestAnimationFrame(() => {
      innerId = requestAnimationFrame(() => {
        resize()
        andThen?.()
      })
    })
    return () => {
      cancelAnimationFrame(outerId)
      cancelAnimationFrame(innerId)
    }
  }, [resize])

  /**
   * Reset the visible height synchronously (used right after submit). On
   * mobile the send button keeps the composer mounted, so waiting for the
   * next animation frame would leave the now-empty textarea at its old
   * multiline height for a frame (and can look stuck if a pending input
   * resize measures first). A follow-up rAF re-measures properly.
   */
  const resetHeightNow = useCallback(() => {
    if (resizeFrameRef.current != null) {
      cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
    }
    const el = textareaRef.current
    if (el) el.style.height = 'auto'
    setIsMultiLine(false)
    promoteLengthRef.current = 0
    requestAnimationFrame(resize)
  }, [resize, textareaRef])

  /** Forget the multi-line promotion (e.g. when expanding an empty composer). */
  const resetMultiLine = useCallback(() => {
    setIsMultiLine(false)
    promoteLengthRef.current = 0
  }, [])

  return {
    isMultiLine,
    resize,
    scheduleResize,
    resizeAfterLayout,
    resetHeightNow,
    resetMultiLine,
  }
}
