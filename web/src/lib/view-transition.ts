/**
 * Crossfade the whole window across a change that repaints everything at
 * once (light ↔ dark, the text size), as macOS does when its appearance
 * changes, instead of every surface switching in one frame.
 *
 * Uses the View Transitions API where the engine has it; elsewhere, under
 * reduced motion, or in a hidden window, the change applies at once. The
 * crossfade's timing lives in index.css (``::view-transition-*(root)``).
 */
import { prefersReducedMotion } from '@/lib/motion'

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> }
}

export function withViewTransition(update: () => void): void {
  const doc = typeof document === 'undefined' ? null : (document as ViewTransitionDocument)
  if (!doc?.startViewTransition || prefersReducedMotion() || doc.visibilityState !== 'visible') {
    update()
    return
  }
  try {
    doc.startViewTransition(update).finished.catch(() => {})
  } catch {
    update()
  }
}
