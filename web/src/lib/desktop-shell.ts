/**
 * Desktop-app chrome for the Tauri shell (macOS, Windows, Linux).
 *
 * A browser tab is a document; the desktop app is an app. Inside Tauri:
 *
 * - ``<html data-shell="desktop">`` turns on the desktop CSS in index.css:
 *   UI chrome does not highlight on drag, buttons use the arrow cursor,
 *   links and images cannot be dragged out.
 * - The webview's own right-click menu (Reload, Back, Inspect, and "Open
 *   Link", which would load the link inside the app) is suppressed. Text
 *   fields and selected text keep the native menu (Copy, Paste, Look Up);
 *   surfaces with an app menu call ``preventDefault`` in their own
 *   ``onContextMenu``, which runs first. Dev builds keep the native menu
 *   for Inspect Element.
 * - ``data-window-inactive`` is set while another app has focus, so the UI
 *   can mute keyboard focus and selections the way native windows do.
 * - ``data-input-modality`` is ``keyboard`` once Tab or F6 moves focus and
 *   ``pointer`` after a pointer press (the start value): the focus ring
 *   follows keyboard navigation, never how focus moved, the way native apps
 *   draw it. WebKit draws ``:focus-visible`` for any script ``focus()`` (the
 *   composer claiming focus at launch, a menu closed with Escape handing
 *   focus back to its button), so index.css hides the ring until then.
 *   Typing, shortcuts (Cmd+B) and Escape are not navigation: a native app
 *   draws no ring for them.
 *
 * The browser build keeps the browser's behaviour: none of this runs there.
 */
import { getPlatform } from '@/hooks/use-platform'

const DESKTOP_OS = new Set(['macos', 'windows', 'linux'])

export function isDesktopShell(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && DESKTOP_OS.has(os)
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

/** The user has selected text: the native menu (Copy, Look Up) wins. */
export function hasTextSelection(): boolean {
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim())
}

/** Whether a right-click should show the webview's native menu. */
export function allowNativeContextMenu(event: MouseEvent, dev = import.meta.env.DEV): boolean {
  return dev || isEditable(event.target) || hasTextSelection()
}

function onContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented || allowNativeContextMenu(event)) return
  event.preventDefault()
}

function setInactive(inactive: boolean): void {
  if (inactive) document.documentElement.setAttribute('data-window-inactive', '')
  else document.documentElement.removeAttribute('data-window-inactive')
}

// Focus moving into a Preview or MCP app iframe blurs the window too; the
// document still has focus then, so check after the move settles.
function onBlur(): void {
  setTimeout(() => setInactive(!document.hasFocus()), 0)
}

function onFocus(): void {
  setInactive(false)
}

type InputModality = 'keyboard' | 'pointer'

/** The keys that move focus between controls. Arrows inside a list or a
 *  menu move a highlight fill, which shows without the ring. */
const NAVIGATION_KEYS = new Set(['Tab', 'F6'])

function setModality(modality: InputModality): void {
  const root = document.documentElement
  if (root.getAttribute('data-input-modality') !== modality) root.setAttribute('data-input-modality', modality)
}

function onKeyDown(event: KeyboardEvent): void {
  if (NAVIGATION_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) setModality('keyboard')
}

function onPointerDown(): void {
  setModality('pointer')
}

let uninstall: (() => void) | null = null

/** Install once at startup; a no-op outside the desktop app. */
export function installDesktopShell(): () => void {
  if (uninstall) return uninstall
  if (typeof window === 'undefined' || !isDesktopShell()) return () => {}
  const root = document.documentElement
  root.setAttribute('data-shell', 'desktop')
  setModality('pointer')
  window.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  // Capture: a handler that stops propagation must not hide the input.
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  uninstall = () => {
    root.removeAttribute('data-shell')
    root.removeAttribute('data-input-modality')
    setInactive(false)
    window.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('pointerdown', onPointerDown, true)
    uninstall = null
  }
  return uninstall
}
