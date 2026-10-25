/**
 * The transcript's one way to open something long (DESIGN.md → Components →
 * Transcript folds): while open, the fold's header pins to the top of the
 * transcript so it can close from anywhere, and closing leaves the header
 * where the control the reader pressed was, so the view never jumps.
 *
 * Pinning is CSS (``PINNED_HEADER``). A fold whose steps hold folds of their
 * own sets ``--fold-top`` on its body to its header's height, so a nested
 * header pins just below it instead of covering it.
 */
import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Classes for an open fold's header; add the fill of the surface it sits on
 * (``bg-(--bg-page)`` in the transcript) to hide what scrolls beneath. z-11
 * clears in-block controls (code copy buttons are z-10) and stays under the
 * composer and the overlaid dock (z-20).
 */
export const PINNED_HEADER = 'sticky top-(--fold-top,0px) z-11'

/** The nearest ancestor that scrolls vertically, i.e. the transcript. */
export function scrollContainer(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/**
 * Keeps a fold's header where the reader pressed when ``open`` turns false.
 * ``anchorRef`` goes on the element that should stay put (the header
 * control); call ``markClose`` with the pressed control just before closing.
 * For folds that own their open state elsewhere; see ``useStickyFold``.
 */
export function useCloseInPlace<T extends HTMLElement = HTMLButtonElement>(open: boolean) {
  const anchorRef = useRef<T>(null)
  // Where the anchor should sit in the view once the fold closes.
  const closeAtRef = useRef<number | null>(null)

  const markClose = (control: HTMLElement) => {
    closeAtRef.current = control.getBoundingClientRect().top
  }

  // Closing drops everything the fold took up, so the reader would land far
  // below the header; scroll it back to where they pressed, before paint.
  useLayoutEffect(() => {
    const top = closeAtRef.current
    closeAtRef.current = null
    const anchor = anchorRef.current
    if (open || top === null || !anchor) return
    const transcript = scrollContainer(anchor)
    const shift = anchor.getBoundingClientRect().top - top
    if (transcript && shift !== 0) transcript.scrollTop += shift
  }, [open])

  return { anchorRef, markClose }
}

/**
 * Open state for a fold whose header pins while open. ``anchorRef`` goes on
 * the element that should stay put when the fold closes (its header
 * control); ``close`` takes the control that was pressed.
 */
export function useStickyFold<T extends HTMLElement = HTMLButtonElement>(initialOpen = false) {
  const [open, setOpen] = useState(initialOpen)
  const { anchorRef, markClose } = useCloseInPlace<T>(open)

  const close = (control: HTMLElement) => {
    markClose(control)
    setOpen(false)
  }

  return { open, setOpen, close, anchorRef }
}
