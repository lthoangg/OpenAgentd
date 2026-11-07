/**
 * Textarea autosize state for InputComposer — height-to-content resizing capped at
 * six lines (``composerMaxHeight``), and the desktop scroll thumb past that.
 *
 * Kept in a separate module (not `.tsx`) so InputComposer.tsx stays HMR-friendly
 * under react-refresh and its render tree stays focused on layout/markup.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Fallback cap in px, where the CSS max-height does not resolve to px. */
export const MAX_TEXTAREA_HEIGHT = 120
/** The box grows to six lines, then it scrolls inside. */
export const COMPOSER_MAX_LINES = 6

/** The textarea's (and its mirror's) CSS max-height. */
export function composerMaxHeight(): string {
  return `${COMPOSER_MAX_LINES}lh`
}

/** The cap ``resize()`` honours: the element's resolved CSS max-height. */
function maxHeightOf(el: HTMLElement): number {
  const value = getComputedStyle(el).maxHeight
  return value.endsWith('px') ? parseFloat(value) : MAX_TEXTAREA_HEIGHT
}

/** The view of a draft taller than its box, as fractions of the draft's height. */
export interface ComposerScrollThumb {
  top: number
  height: number
}

function sameThumb(a: ComposerScrollThumb | null, b: ComposerScrollThumb | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a.top - b.top) < 1e-4 && Math.abs(a.height - b.height) < 1e-4
}

/**
 * Where the box's own scroll stands while the draft is taller than the box;
 * null while it fits, or when ``enabled`` is off. The box hides its
 * scrollbar (it would narrow the text under the overlay mirror), so the
 * desktop composer draws this beside the text instead.
 */
export function useComposerScrollThumb(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  enabled: boolean,
  value: string,
): ComposerScrollThumb | null {
  const [thumb, setThumb] = useState<ComposerScrollThumb | null>(null)
  const measure = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const { scrollHeight, clientHeight, scrollTop } = el
    const next = scrollHeight > clientHeight + 1 ? { top: scrollTop / scrollHeight, height: clientHeight / scrollHeight } : null
    setThumb((current) => (sameThumb(current, next) ? current : next))
  }, [textareaRef])

  useEffect(() => {
    const el = textareaRef.current
    if (!el || !enabled) return
    el.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [enabled, measure, textareaRef])

  // A keystroke changes the draft's height in the autosize frame: measure
  // the frame after (requested later, so it runs after the resize).
  useEffect(() => {
    if (!enabled) return
    const id = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(id)
  }, [enabled, measure, value])

  return enabled ? thumb : null
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
