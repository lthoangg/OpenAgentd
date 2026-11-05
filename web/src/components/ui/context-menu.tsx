/**
 * ContextMenu — a pointer-anchored menu for right-click actions.
 *
 * Items stay caller-owned ``<button role="menuitem">`` (or
 * ``role="menuitemradio"`` for a pick-one list, ``role="menuitemcheckbox"``
 * for a toggle) elements; the menu
 * adds what every hand-rolled copy was missing: it focuses the first item,
 * moves with ArrowUp/ArrowDown/Home/End (skipping disabled items), closes on
 * Escape, Tab, a backdrop click or another right-click, returns focus to
 * whatever opened it, and keeps itself inside the viewport.
 *
 * Motion matches Dropdown (DESIGN.md → Motion): it grows out of the pointer
 * at ``base``. Dismissed with the pointer (a click or right-click outside),
 * it fades back at ``fast``, out of reach (``inert``) meanwhile, and the
 * caller's ``onDismiss`` runs when the fade ends. Dismissed from the keyboard
 * (Escape, Tab) it closes at once, so the next key lands where it should; an
 * item that closes the menu itself unmounts it straight away too.
 *
 * The app draws it in every shell, desktop and iOS included: native is the
 * feel (it opens at the pointer, keys move through it), not the operating
 * system's widget, so it looks like every other menu in the app.
 *
 * It renders into ``document.body`` on the menu layer (``z-70``: above the
 * notices in the corner, below tooltips), as Dropdown and Popover do. Drawn
 * where it was opened, a menu was caught by that component's stacking
 * context (the dock's z-index, a transform, container queries) and could
 * open under its neighbours. React events still bubble to the opener.
 *
 * It is a transient layer (``lib/keyboard/layers``): opening it closes the
 * other menus and popovers, and Settings, a dialog or an app shortcut
 * opening over it closes it, so two menus are never open at once.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { KeyLayerScope, useKeyLayer } from '@/lib/keyboard/hooks'
import { DURATIONS_S } from '@/lib/motion'
import { MENU_ITEM_CLASS, MENU_ITEM_DANGER, MENU_PANEL_CLASS, MENU_SEPARATOR_CLASS } from '@/components/ui/menu-styles'
import { blinkThen, isBlinking, shouldBlink } from '@/components/ui/_menu-blink'

/** Gap kept between the menu and the viewport edge. */
const VIEWPORT_MARGIN = 8
const EXIT_MS = DURATIONS_S.fast * 1000

/** Menus, dropdowns and popovers: above the notices (z-60), below tooltips. */
export const MENU_LAYER_CLASS = 'z-70'

const MENU_CLASS = `fixed text-xs text-(--color-text) ease-(--ease-out) ${MENU_PANEL_CLASS}`

export const CONTEXT_MENU_ITEM_CLASS =
  `${MENU_ITEM_CLASS} text-(--color-text) focus-visible:outline-none disabled:cursor-default disabled:opacity-50`
export const CONTEXT_MENU_ITEM_DANGER_CLASS =
  `${MENU_ITEM_CLASS} ${MENU_ITEM_DANGER} text-(--color-error) focus-visible:outline-none disabled:cursor-default disabled:opacity-50`

export function ContextMenuSeparator() {
  return <div role="separator" className={MENU_SEPARATOR_CLASS} />
}

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

function isDisabled(item: HTMLElement): boolean {
  return item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true'
}

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((item) => !isDisabled(item))
}

interface ContextMenuProps {
  /** Pointer position (``clientX`` / ``clientY``) the menu opens at. */
  at: { x: number; y: number }
  label: string
  onDismiss: () => void
  /** Width and other overrides; defaults to ``min-w-40``. */
  className?: string
  children: ReactNode
}

export function ContextMenu({ at, label, onDismiss, className = 'min-w-40', children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const reduced = useReducedMotion() ?? false
  const [closing, setClosing] = useState(false)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  // Clamp after measuring, straight on the node: no second render, and React
  // leaves top/left alone while ``at`` is unchanged.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    const left = Math.max(VIEWPORT_MARGIN, Math.min(at.x, window.innerWidth - width - VIEWPORT_MARGIN))
    const top = Math.max(VIEWPORT_MARGIN, Math.min(at.y, window.innerHeight - height - VIEWPORT_MARGIN))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    // Grow out of the corner nearest the pointer, flipped when clamped.
    menu.style.transformOrigin = `${left < at.x ? 'right' : 'left'} ${top < at.y ? 'bottom' : 'top'}`
  }, [at.x, at.y])

  // Another right-click while it fades (callers keep ``at`` in state, so a
  // new point is a new object) reopens it instead of letting it close.
  useLayoutEffect(() => {
    if (!exitTimerRef.current) return
    clearTimeout(exitTimerRef.current)
    exitTimerRef.current = null
    setClosing(false)
    enabledItems(menuRef.current)[0]?.focus({ preventScroll: true })
  }, [at])

  useEffect(() => {
    const menu = menuRef.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openerRef.current = opener
    enabledItems(menu)[0]?.focus({ preventScroll: true })
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
      // Only reclaim focus the menu took; an item that opened a dialog keeps it.
      const active = document.activeElement
      const lost = !active || active === document.body || (menu?.contains(active) ?? false)
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  const dismiss = useCallback((fade: boolean) => {
    if (reduced || !fade) {
      onDismissRef.current()
      return
    }
    if (exitTimerRef.current) return
    const opener = openerRef.current
    const active = document.activeElement
    if (opener?.isConnected && (!active || active === document.body || menuRef.current?.contains(active))) {
      opener.focus({ preventScroll: true })
    }
    setClosing(true)
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null
      onDismissRef.current()
    }, EXIT_MS)
  }, [reduced])

  // One menu at a time: something else opening over the app closes it, at
  // once (the key or click that did it belongs to that, not to this menu).
  const layer = useKeyLayer(true, { kind: 'transient', onClose: () => dismiss(false) })

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems(menuRef.current)
    const index = items.indexOf(document.activeElement as HTMLElement)
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus()
    switch (event.key) {
      case 'Escape':
      case 'Tab':
        event.preventDefault()
        // Keep an enclosing overlay's Escape from closing it as well.
        event.stopPropagation()
        dismiss(false)
        return
      case 'ArrowDown':
        event.preventDefault()
        focusAt(index + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        focusAt(index < 0 ? items.length - 1 : index - 1)
        return
      case 'Home':
        event.preventDefault()
        focusAt(0)
        return
      case 'End':
        event.preventDefault()
        focusAt(items.length - 1)
        return
    }
  }

  // Choosing an item blinks its row once, then its own handler runs (and the
  // menu closes): the click is held back in the capture phase and replayed
  // when the blink ends, so callers' handlers stay as they were. A key press
  // on a focused item arrives as a click too, so Enter and Space blink alike.
  const replayingRef = useRef(false)
  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (replayingRef.current || !(event.target instanceof Element)) return
    const item = event.target.closest<HTMLElement>(ITEM_SELECTOR)
    if (!item || !menuRef.current?.contains(item)) return
    if (isBlinking(item)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!shouldBlink(item)) return
    event.preventDefault()
    event.stopPropagation()
    blinkThen(item, () => {
      if (!item.isConnected) return
      replayingRef.current = true
      try {
        item.click()
      } finally {
        replayingRef.current = false
      }
    })
  }

  return createPortal(
    <div
      role="presentation"
      className={cn('fixed inset-0 bg-transparent', MENU_LAYER_CLASS, closing && 'pointer-events-none')}
      onClick={() => dismiss(true)}
      onContextMenu={(event) => {
        event.preventDefault()
        dismiss(true)
      }}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        aria-orientation="vertical"
        inert={closing}
        aria-hidden={closing || undefined}
        className={cn(
          MENU_CLASS,
          closing
            ? 'animate-out fade-out-0 zoom-out-95 fill-mode-forwards animation-duration-(--motion-fast)'
            : 'animate-in fade-in-0 zoom-in-95 animation-duration-(--motion-base)',
          className,
        )}
        style={{ left: at.x, top: at.y }}
        onClickCapture={handleClickCapture}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <KeyLayerScope layer={layer}>{children}</KeyLayerScope>
      </div>
    </div>,
    document.body,
  )
}
