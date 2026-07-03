/**
 * useLongPressSurface — press-and-hold gesture for a non-<button> surface.
 *
 * xterm's DOM isn't a button (`LongPressButton` doesn't apply), but the
 * mobile terminal surface needs the same affordance: hold to reveal
 * Select All / Copy / Paste, since touch has no native context menu and
 * xterm's own touch handling already owns tap/drag for scroll + selection.
 *
 * Thin wrapper over the shared `useLongPress` core (same thresholds as
 * `LongPressButton`) — no visual press state here since a terminal
 * surface doesn't have a "scale down" affordance to show.
 */
import { useLongPress, type LongPressHandlers } from '@/hooks/use-long-press'

export function useLongPressSurface(enabled: boolean, onLongPress: () => void): LongPressHandlers {
  return useLongPress(enabled, onLongPress)
}
