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
 * In the desktop app the operating system draws it: the items are read from
 * the (hidden) page menu and handed to ``showNativeMenu``, and the chosen one
 * is clicked, so every caller gets the native menu with no change of its own.
 * Menus whose items are more than a label (a field, a chip) pass
 * ``native={false}``. When the shell cannot show a menu, the page menu shows.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { isDesktopShell } from '@/lib/desktop-shell'
import { DURATIONS_S } from '@/lib/motion'
import { showNativeMenu, type NativeMenuItem } from '@/lib/native-menu'
import { MENU_ITEM_CLASS, MENU_ITEM_DANGER, MENU_PANEL_CLASS, MENU_SEPARATOR_CLASS } from '@/components/ui/menu-styles'

/** Gap kept between the menu and the viewport edge. */
const VIEWPORT_MARGIN = 8
const EXIT_MS = DURATIONS_S.fast * 1000

const MENU_CLASS = `fixed z-50 text-xs text-(--color-text) ease-(--ease-out) ${MENU_PANEL_CLASS}`

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

/**
 * Whether the OS can draw this menu: the desktop app, with its IPC bridge
 * loaded. Without the bridge the native request could only fail a tick
 * later, so the page menu shows at once instead.
 */
function canShowNativeMenu(): boolean {
  return isDesktopShell() && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((item) => !isDisabled(item))
}

/** An item's words, without icons and decorative hints such as a shortcut. */
function itemLabel(item: HTMLElement): string {
  const own = item.dataset.nativeLabel
  if (own) return own
  const copy = item.cloneNode(true) as HTMLElement
  copy.querySelectorAll('svg, kbd, [aria-hidden="true"]').forEach((node) => node.remove())
  // Words in separate elements ("main" + a "folder" chip) stay separate words.
  const words: string[] = []
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text) words.push(text)
  }
  return words.join(' ').replace(/\s+/g, ' ') || (item.getAttribute('aria-label') ?? '')
}

/**
 * The page menu as native items: each item's id is its index among the
 * items, separators keep their place, and neither leads nor doubles up.
 */
function readNativeItems(menu: HTMLElement): { items: NativeMenuItem[]; elements: HTMLElement[] } {
  const items: NativeMenuItem[] = []
  const elements: HTMLElement[] = []
  for (const node of menu.querySelectorAll<HTMLElement>(`${ITEM_SELECTOR}, [role="separator"]`)) {
    if (node.getAttribute('role') === 'separator') {
      const last = items[items.length - 1]
      if (last && !('separator' in last && last.separator)) items.push({ separator: true })
      continue
    }
    const role = node.getAttribute('role')
    const checked = role === 'menuitem' ? undefined : node.getAttribute('aria-checked') === 'true'
    items.push({ id: String(elements.length), label: itemLabel(node), enabled: !isDisabled(node), ...(checked === undefined ? {} : { checked }) })
    elements.push(node)
  }
  const last = items[items.length - 1]
  if (last && 'separator' in last && last.separator) items.pop()
  return { items, elements }
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
  /** ``false`` keeps the page menu in the desktop app too, for items that are more than a label. */
  native?: boolean
  children: ReactNode
}

export function ContextMenu({ at, label, onDismiss, className = 'min-w-40', layerClassName = 'z-50', native = true, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const reduced = useReducedMotion() ?? false
  const [closing, setClosing] = useState(false)
  // ``native``: the OS menu is up (or being asked for) and the page menu
  // stays hidden; ``page``: the page menu shows.
  const [mode, setMode] = useState<'native' | 'page'>(() => (native && canShowNativeMenu() ? 'native' : 'page'))
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
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
      // Only reclaim focus the menu took; an item that opened a dialog keeps it.
      const active = document.activeElement
      const lost = !active || active === document.body || (menu?.contains(active) ?? false)
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    if (mode === 'page') enabledItems(menuRef.current)[0]?.focus({ preventScroll: true })
  }, [mode])

  // The native menu answers once per opening; a later ``at`` while it is up
  // cannot move it, so it reads the point it opened at.
  const openedAtRef = useRef(at)
  useEffect(() => {
    if (mode !== 'native') return
    const menu = menuRef.current
    if (!menu) return
    let live = true
    const { items, elements } = readNativeItems(menu)
    void showNativeMenu(items, openedAtRef.current).then((chosen) => {
      if (!live) return
      if (chosen === undefined) {
        setMode('page')
        return
      }
      const item = chosen === null ? undefined : elements[Number(chosen)]
      // React handles the click synchronously, so an item that closes the
      // menu has unmounted it (``live`` false) by the time this returns.
      if (item?.isConnected) item.click()
      if (live) onDismissRef.current()
    })
    return () => {
      live = false
    }
  }, [mode])

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

  return (
    <div
      role="presentation"
      className={cn('fixed inset-0 bg-transparent', (closing || mode === 'native') && 'pointer-events-none', mode === 'native' && 'invisible', layerClassName)}
      aria-hidden={mode === 'native' || undefined}
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
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  )
}
