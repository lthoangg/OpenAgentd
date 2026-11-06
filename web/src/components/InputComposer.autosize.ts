/**
 * Textarea autosize state for InputComposer — height-to-content resizing capped at
 * ``MAX_TEXTAREA_HEIGHT``.
 *
 * Kept in a separate module (not `.tsx`) so InputComposer.tsx stays HMR-friendly
 * under react-refresh and its render tree stays focused on layout/markup.
 */
import { useCallback, useEffect, useRef } from 'react'

/** Height cap in px off a phone. Must match the textarea's inline ``maxHeight`` style. */
export const MAX_TEXTAREA_HEIGHT = 120
/** A phone grows the box to six lines, then it scrolls inside (Phone system). */
export const PHONE_MAX_LINES = 6

/** The textarea's (and its mirror's) CSS max-height. */
export function composerMaxHeight(phone: boolean): string {
  return phone ? `${PHONE_MAX_LINES}lh` : `${MAX_TEXTAREA_HEIGHT}px`
}

/** The cap ``resize()`` honours: the element's resolved CSS max-height. */
function maxHeightOf(el: HTMLElement): number {
  const value = getComputedStyle(el).maxHeight
  return value.endsWith('px') ? parseFloat(value) : MAX_TEXTAREA_HEIGHT
}

export function useTextareaAutosize(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  const resizeFrameRef = useRef<number | null>(null)

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // Measuring collapses the box, which grows the docked transcript above it;
    // the browser clamps its scrollTop and keeps the clamp. Put it back.
    const scroller = el.closest('main')?.querySelector<HTMLElement>('.oa-chat-scroll')
    const scrollTop = scroller?.scrollTop ?? 0
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeightOf(el))}px`
    if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop
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
  // parent expand animation (e.g. FloatingInputComposer minimized→expanded
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
    requestAnimationFrame(resize)
  }, [resize, textareaRef])

  return {
    resize,
    scheduleResize,
    resizeAfterLayout,
    resetHeightNow,
  }
}
