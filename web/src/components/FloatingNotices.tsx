/**
 * FloatingNotices — the one top-right column for the app's non-blocking
 * cards: toasts, the TypeScript tools prompt, and the update card. Sharing a
 * column makes them stack instead of landing on the same spot. It hangs under
 * the app header (``.mobile-safe-floating``, safe areas included) on every
 * screen, full width on phones, so the composer and its run deck own the
 * bottom. Toasts come first, newest nearest the top edge (see ``ToastStack``).
 */
import { ToastStack } from '@/components/ToastStack'
import { lazySurface } from '@/lib/lazy-surface'

// Shown only when there is an update or a language server to install: kept
// out of the startup bundle and prefetched while the app is idle.
const LspInstallPrompt = lazySurface(() => import('@/components/LspInstallPrompt'), 'LspInstallPrompt')
const UpdateCard = lazySurface(() => import('@/components/UpdateCard'), 'UpdateCard')

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
