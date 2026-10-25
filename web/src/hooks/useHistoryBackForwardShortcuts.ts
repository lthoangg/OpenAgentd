import { useRouter } from '@tanstack/react-router'
import { getPlatform } from '@/hooks/use-platform'
import { appShortcut, useShortcuts } from '@/lib/keyboard/hooks'
import { HISTORY_ALT_BACK, HISTORY_ALT_FORWARD, usesAltArrowHistory } from '@/lib/keyboard/history-keys'

/**
 * ``⌘[`` / ``⌘]`` (``Ctrl+[`` / ``Ctrl+]`` on Windows/Linux) — step
 * backward/forward through the app's own navigation history, mirroring
 * the identical shortcut in every major desktop browser (Safari, Chrome,
 * Edge).
 * Windows and Linux also get ``Alt+←`` / ``Alt+→``, their system
 * back/forward keys. Being unmodified chords, they never fire in a text
 * field or the terminal, where Alt+arrow moves by word.
 *
 * This drives the router's history stack directly (``router.history``,
 * TanStack Router's wrapper around the real ``window.history``), so it
 * works the same everywhere in the app — settings, telemetry, workspaces and
 * sessions alike. Registered once, globally, in
 * ``__root.tsx``.
 */
export function useHistoryBackForwardShortcuts(): void {
  const router = useRouter()
  const altEnabled = () => ({ enabled: usesAltArrowHistory(getPlatform().os) })
  useShortcuts([
    appShortcut('historyBack', () => { router.history.back() }),
    appShortcut('historyForward', () => { router.history.forward() }),
    { chord: HISTORY_ALT_BACK, handler: () => { router.history.back() }, options: altEnabled() },
    { chord: HISTORY_ALT_FORWARD, handler: () => { router.history.forward() }, options: altEnabled() },
  ])
}
