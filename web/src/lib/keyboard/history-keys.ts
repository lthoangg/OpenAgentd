import type { OS } from '@/hooks/use-platform'
import type { KeyChord } from './chord'

/**
 * Alt+← / Alt+→: back and forward on Windows and Linux, next to the
 * ⌘[ / Ctrl+[ table entries. macOS (and iPadOS) keep ⌥← / ⌥→ for moving by
 * word, so they are not bound there.
 */
export const HISTORY_ALT_BACK: KeyChord = { key: 'ArrowLeft', alt: true }
export const HISTORY_ALT_FORWARD: KeyChord = { key: 'ArrowRight', alt: true }

export function usesAltArrowHistory(os: OS): boolean {
  return os === 'windows' || os === 'linux'
}
