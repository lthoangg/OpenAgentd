import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { getPlatform } from '@/hooks/use-platform'
import { isPrimaryShortcut } from '@/lib/keyboard-shortcut'

/**
 * ``⌘[`` / ``⌘]`` (``Ctrl+[`` / ``Ctrl+]`` on Windows/Linux) — step
 * backward/forward through the app's own navigation history, mirroring
 * the identical shortcut in every major desktop browser (Safari, Chrome,
 * Edge).
 *
 * This drives the router's history stack directly (``router.history``,
 * TanStack Router's wrapper around the real ``window.history``), so it
 * works the same everywhere in the app — settings, telemetry, cockpit
 * and coding sessions — not just chat. Registered once, globally, in
 * ``__root.tsx``.
 */
export function useHistoryBackForwardShortcuts(): void {
  const router = useRouter()

  useEffect(() => {
    const { os } = getPlatform()
    const handler = (e: KeyboardEvent) => {
      if (!isPrimaryShortcut(e, os)) return
      if (e.key === '[') {
        e.preventDefault()
        router.history.back()
      } else if (e.key === ']') {
        e.preventDefault()
        router.history.forward()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [router])
}
