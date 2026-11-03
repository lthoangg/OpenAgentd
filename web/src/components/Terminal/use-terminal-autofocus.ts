/**
 * useTerminalAutoFocus — focus the terminal when the user opens it, not when
 * its status flips.
 *
 * The view attaches on every lifecycle change (connecting, connected, busy,
 * reconnecting…); calling ``term.focus()`` there pulled focus out of the
 * composer whenever a status changed while the user typed elsewhere. Here
 * each terminal is focused once per mount of the view:
 *
 * - The terminal is there when the view mounts: the user just opened or
 *   activated its tab, so it takes focus.
 * - It arrives later (the xterm chunk loaded, or a reconnect swapped in a new
 *   one): it takes focus only if nothing else holds it, never from a text
 *   field such as the composer.
 */
import { useEffect, useRef, type RefObject } from 'react'

import { isEditableTarget } from '@/lib/is-editable-target'

export function useTerminalAutoFocus(term: { focus: () => void } | null | undefined, rootRef: RefObject<HTMLElement | null>): void {
  const ranRef = useRef(false)
  useEffect(() => {
    const isMount = !ranRef.current
    ranRef.current = true
    if (!term) return
    const active = document.activeElement
    const heldElsewhere = active !== null && active !== document.body && isEditableTarget(active) && !rootRef.current?.contains(active)
    if (isMount || !heldElsewhere) term.focus()
  }, [term, rootRef])
}
