/**
 * useTerminalAutoFocus — focus the terminal when the user opens it, not when
 * its status flips.
 *
 * The view attaches on every lifecycle change (connecting, connected, busy,
 * reconnecting…); calling ``term.focus()`` there pulled focus out of the
 * composer whenever a status changed while the user typed elsewhere. Here
 * focus is owed once per mount of the view, to the first terminal it shows:
 *
 * - Mounting means the user just opened or activated the tab, so its first
 *   terminal takes focus, even from the composer. That holds when the
 *   terminal arrives after the mount, which a new shell always does: its
 *   xterm handle is built after an async import. A click outside the
 *   terminal while it loads cancels the debt (the user moved on); a focus
 *   change alone does not, since closing the palette hands focus back to
 *   the composer by itself.
 * - A later terminal in the same mount (a reconnect swapped in a new one)
 *   takes focus only if nothing else holds it, never from a text field.
 */
import { useEffect, useRef, type RefObject } from 'react'

import { isEditableTarget } from '@/lib/is-editable-target'

export function useTerminalAutoFocus(term: { focus: () => void } | null | undefined, rootRef: RefObject<HTMLElement | null>): void {
  const owedRef = useRef(true)

  // While focus is owed, a click outside the terminal means the user moved on.
  useEffect(() => {
    if (!owedRef.current) return
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return
      owedRef.current = false
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [rootRef])

  useEffect(() => {
    if (!term) return
    const owed = owedRef.current
    owedRef.current = false
    const active = document.activeElement
    const heldElsewhere = active !== null && active !== document.body && isEditableTarget(active) && !rootRef.current?.contains(active)
    if (owed || !heldElsewhere) term.focus()
  }, [term, rootRef])
}
