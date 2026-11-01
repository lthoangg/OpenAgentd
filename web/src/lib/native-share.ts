/**
 * The system share sheet, from the desktop app: ``NSSharingServicePicker`` on
 * macOS and the Share window on Windows. Linux has none, so callers copy the
 * link; the browser and the phone apps use Web Share (see ``session-link.ts``).
 */
import { getPlatform } from '@/hooks/use-platform'

export interface SharePoint {
  x: number
  y: number
}

/** Whether this app has a native share sheet: the macOS and Windows desktop apps. */
export function canShareNatively(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'macos' || os === 'windows')
}

// The sheet opens anchored where the user clicked. A menu item's action runs
// after its click, so the last press is the best anchor when nothing says.
let lastPress: SharePoint | null = null

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (event) => {
      lastPress = { x: event.clientX, y: event.clientY }
    },
    { capture: true, passive: true },
  )
}

/** Where the user last pressed, or near the top of the window before any press. */
export function lastPressPoint(): SharePoint {
  return lastPress ?? { x: Math.round((typeof window === 'undefined' ? 0 : window.innerWidth) / 2), y: 48 }
}

/**
 * Show the system share sheet for ``url`` (macOS: anchored at ``at`` in the
 * window; Windows: its own Share window). Resolves ``true`` once it is shown,
 * ``false`` where there is no native share sheet or it could not open, and
 * the caller shares another way.
 */
export async function shareNative(url: string, title: string, at: SharePoint = lastPressPoint()): Promise<boolean> {
  if (!canShareNatively()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('share_url', { url, title, x: at.x, y: at.y })
    return true
  } catch (err) {
    console.debug('native share unavailable', err)
    return false
  }
}
