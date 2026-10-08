/**
 * FloatingNotices — the one bottom-right column for the app's non-blocking
 * cards: toasts, the TypeScript tools prompt, and the update card. Sharing a
 * column makes them stack instead of landing on the same spot. On desktop the
 * column clears the status bar (``.mobile-safe-floating``); on phones toasts
 * keep their own top slot (see ``ToastStack``).
 */
import { LspInstallPrompt } from '@/components/LspInstallPrompt'
import { ToastStack } from '@/components/ToastStack'
import { UpdateCard } from '@/components/UpdateCard'

export function FloatingNotices() {
  return (
    <div
      data-floating-notices
      className="mobile-safe-floating pointer-events-none fixed z-60 flex flex-col items-end gap-2"
    >
      <ToastStack />
      <LspInstallPrompt />
      <UpdateCard />
    </div>
  )
}
