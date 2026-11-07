import { useEffect, useRef } from 'react'

import { useKeyLayer } from '@/lib/keyboard/hooks'
import { isTopLayer, type LayerKind } from '@/lib/keyboard/layers'

export interface ModalLayerOptions {
  /** ``dialog`` (default) blocks every app shortcut; ``overlay`` lets switchers through. */
  kind?: Extract<LayerKind, 'dialog' | 'overlay'>
  /** ``false`` keeps switchers out, e.g. Settings with unsaved changes. */
  allowSwitch?: () => boolean
}

/**
 * Focus trap + Escape for modal surfaces.
 *
 * `initialFocus` overrides where focus lands on open. Without it, focus goes to
 * the first focusable element in DOM order, which for a panel with a header is
 * the close button — technically correct, practically useless, since the user
 * then has to Tab past it to reach the content they opened the panel for.
 *
 * Focus moves with ``preventScroll``: on iOS, focusing a fixed sheet while the
 * keyboard is up (a ``/btw`` sent from the composer) otherwise scrolls the
 * whole page up to bring it above the keyboard, and the chat jumps.
 *
 * The modal is a layer on the keyboard stack (``lib/keyboard``): Escape goes
 * to whichever layer opened last, and app shortcuts behind it are blocked.
 */
export function useModalFocus(
  open: boolean,
  onClose?: () => void,
  initialFocus?: React.RefObject<HTMLElement | null>,
  layer: ModalLayerOptions = {},
): { readonly current: number | null } {
  // Keep a ref so the keydown handler always calls the latest onClose without
  // needing to be re-registered every time the parent re-renders with a new
  // callback reference. Without this, the listener briefly vanishes during
  // the teardown+re-add window, dropping any Escape press that lands there.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Same reasoning: read the target at focus time, not at registration time.
  const initialFocusRef = useRef(initialFocus)
  useEffect(() => { initialFocusRef.current = initialFocus })

  const dialogRef = useRef<HTMLElement | null>(null)
  const layerId = useKeyLayer(open, {
    kind: layer.kind ?? 'dialog',
    onClose: () => onCloseRef.current?.(),
    allowSwitch: layer.allowSwitch,
    element: () => dialogRef.current,
  })

  useEffect(() => {
    if (!open) return
    const previousActive = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const dialogs = document.querySelectorAll<HTMLElement>('[data-modal-focus="true"]')
    const dialog = dialogs[dialogs.length - 1] ?? null
    dialogRef.current = dialog
    const isVisible = (el: HTMLElement) => el.getClientRects().length > 0
    const focusFirst = () => {
      const preferred = initialFocusRef.current?.current
      if (preferred && preferred.isConnected && isVisible(preferred)) {
        preferred.focus({ preventScroll: true })
        return
      }
      const target = Array.from(dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).find(isVisible)
      target?.focus({ preventScroll: true })
    }
    const id = requestAnimationFrame(focusFirst)

    // Escape is routed by the keyboard dispatcher to the top layer.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || !dialog || !isTopLayer(layerId.current)) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((el) => !el.hasAttribute('disabled') && isVisible(el))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('keydown', handleKeyDown)
      if (dialogRef.current === dialog) dialogRef.current = null
      if (previousActive?.isConnected) previousActive.focus({ preventScroll: true })
    }
  }, [open, layerId]) // onClose intentionally omitted — read via ref above

  // For shortcuts the modal owns (``useShortcut(chord, fn, { layer })``).
  return layerId
}
