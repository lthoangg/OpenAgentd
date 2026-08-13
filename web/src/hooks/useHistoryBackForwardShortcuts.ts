import { useHotkeys } from '@tanstack/react-hotkeys'
import { useRouter } from '@tanstack/react-router'
import { getPlatform } from '@/hooks/use-platform'

function hotkeyPlatform() {
  const { os } = getPlatform()
  return os === 'macos' ? 'mac' : os === 'windows' ? 'windows' : 'linux'
}

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
  useHotkeys(
    [
      {
        hotkey: 'Mod+[',
        callback: () => router.history.back(),
        options: { meta: { name: 'History back', description: 'Navigate backward' } },
      },
      {
        hotkey: 'Mod+]',
        callback: () => router.history.forward(),
        options: { meta: { name: 'History forward', description: 'Navigate forward' } },
      },
    ],
    {
      target: document,
      platform: hotkeyPlatform(),
      preventDefault: true,
      stopPropagation: false,
      ignoreInputs: false,
    },
  )
}
