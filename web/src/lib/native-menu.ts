/**
 * The application menu for Windows and Linux.
 *
 * Menus the page builds (right-click, ⋯, long-press sheets) are always the
 * app's own (``components/ui/context-menu``): native is the feel, not the
 * OS widget. The one exception is the window's own menu bar.
 *
 * ``showAppMenu`` pops the application menu up for Windows and Linux, where
 * the native menu bar is hidden and the header's ☰ button (or a bare Alt tap)
 * opens it.
 */
import { getPlatform } from '@/hooks/use-platform'
import { isDesktopShell } from '@/lib/desktop-shell'

/** A point in CSS pixels from the page's top-left corner (client coordinates). */
export interface NativeMenuPoint {
  x: number
  y: number
}

/** The header's ☰ button exists only where the OS menu bar is hidden: Windows and Linux. */
export function hasAppMenuButton(): boolean {
  if (!isDesktopShell()) return false
  const { os } = getPlatform()
  return os === 'windows' || os === 'linux'
}

/**
 * Pop the application menu up at ``at``. Resolves ``true`` once it has been
 * shown and closed, ``false`` where there is none to show. The chosen item
 * runs in the shell, like any menu bar item.
 */
export async function showAppMenu(at: NativeMenuPoint): Promise<boolean> {
  if (!hasAppMenuButton()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('show_app_menu', { x: at.x, y: at.y })
    return true
  } catch (err) {
    console.debug('application menu unavailable', err)
    return false
  }
}

/** Whether ``target`` takes typed text, so a bare Alt tap there is not for the menu. */
function takesText(target: Element | null): boolean {
  if (!target) return false
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null
}

/**
 * Detects a bare Alt tap: Alt pressed and released with nothing between, the
 * way Windows and Linux open a menu bar. Alt held with another key, a mouse
 * press or another modifier is a shortcut or a click, and a tap while a text
 * field has focus belongs to that field. Losing focus (Alt+Tab) cancels it.
 * ``onTap`` runs on the release. Returns the listeners to attach to ``window``.
 */
export function createAltTapDetector(onTap: () => void): {
  onKeyDown: (event: KeyboardEvent) => void
  onKeyUp: (event: KeyboardEvent) => void
  onPointerDown: () => void
  onBlur: () => void
} {
  let armed = false
  return {
    onKeyDown(event) {
      if (event.key !== 'Alt') {
        armed = false
        return
      }
      // Held-down repeats must not re-arm after another key disarmed it, and
      // Alt with Ctrl/Meta/Shift already down is a chord, not a tap.
      if (event.repeat) return
      armed = !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.defaultPrevented
    },
    onKeyUp(event) {
      if (event.key !== 'Alt') return
      const tapped = armed
      armed = false
      if (tapped && !takesText(document.activeElement)) onTap()
    },
    onPointerDown() {
      armed = false
    },
    onBlur() {
      armed = false
    },
  }
}
