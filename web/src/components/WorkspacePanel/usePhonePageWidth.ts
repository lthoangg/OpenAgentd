/**
 * The width of the screen a phone's Review page covers: how far it travels to
 * leave (``DrawerMotion.hidden``). Follows a turn of the phone.
 *
 * ``0`` while off, and then a resize never re-renders the dock: this is read
 * by the one surface that needs it, so the desktop's window drags (and the
 * narrow window's) cost nothing here.
 */
import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export function usePhonePageWidth(enabled: boolean): number {
  return useSyncExternalStore(subscribe, () => (enabled ? window.innerWidth : 0), () => 0)
}
