/**
 * ContextMenu — a pointer-anchored menu for right-click actions.
 *
 * Items stay caller-owned ``<button role="menuitem">`` (or
 * ``role="menuitemradio"`` for a pick-one list) elements; the menu
 * adds what every hand-rolled copy was missing: it focuses the first item,
 * moves with ArrowUp/ArrowDown/Home/End (skipping disabled items), closes on
 * Escape, Tab, a backdrop click or another right-click, returns focus to
 * whatever opened it, and keeps itself inside the viewport.
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { MENU_ITEM_CLASS, MENU_PANEL_CLASS, MENU_SEPARATOR_CLASS } from '@/components/ui/menu-styles'

/** Gap kept between the menu and the viewport edge. */
const VIEWPORT_MARGIN = 8

const MENU_CLASS = `fixed z-50 text-xs text-(--color-text) ${MENU_PANEL_CLASS}`

export const CONTEXT_MENU_ITEM_CLASS =
  `${MENU_ITEM_CLASS} text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:bg-(--bg-key) focus-visible:outline-none disabled:cursor-default disabled:opacity-50`
export const CONTEXT_MENU_ITEM_DANGER_CLASS =
  `${MENU_ITEM_CLASS} text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none disabled:cursor-default disabled:opacity-50`

export function ContextMenuSeparator() {
  return <div role="separator" className={MENU_SEPARATOR_CLASS} />
}

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')).filter(
    (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true',
  )
}

interface ContextMenuProps {
  /** Pointer position (``clientX`` / ``clientY``) the menu opens at. */
  at: { x: number; y: number }
  label: string
  onDismiss: () => void
  /** Width and other overrides; defaults to ``min-w-40``. */
  className?: string
  /** Stacking layer for the backdrop; raise it inside overlays above ``z-50``. */
  layerClassName?: string
  children: ReactNode
}

export function ContextMenu({ at, label, onDismiss, className = 'min-w-40', layerClassName = 'z-50', children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Clamp after measuring, straight on the node: no second render, and React
  // leaves top/left alone while ``at`` is unchanged.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(at.x, window.innerWidth - width - VIEWPORT_MARGIN))}px`
    menu.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(at.y, window.innerHeight - height - VIEWPORT_MARGIN))}px`
  }, [at.x, at.y])

  useEffect(() => {
    const menu = menuRef.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    enabledItems(menu)[0]?.focus({ preventScroll: true })
    return () => {
      // Only reclaim focus the menu took; an item that opened a dialog keeps it.
      const active = document.activeElement
      const lost = !active || active === document.body || (menu?.contains(active) ?? false)
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

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
        onDismiss()
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

  return (
    <div
      role="presentation"
      className={cn('fixed inset-0 bg-transparent', layerClassName)}
      onClick={onDismiss}
      onContextMenu={(event) => {
        event.preventDefault()
        onDismiss()
      }}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        aria-orientation="vertical"
        className={cn(MENU_CLASS, className)}
        style={{ left: at.x, top: at.y }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  )
}
