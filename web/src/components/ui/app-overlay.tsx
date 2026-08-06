/**
 * AppOverlay — the single overlay primitive for the entire app.
 *
 * Every fullscreen panel (modals, command palettes) uses this instead of
 * rolling their own `fixed` positioning, backdrop, animation, and keyboard
 * handling. Settings is the visual reference; this matches its geometry.
 *
 * ## Variants
 *
 * `"modal"` — centred card (default)
 *   • Mobile  : full edge-to-edge sheet (0.5rem inset, safe-area aware)
 *   • Desktop : centred card, max-width configurable (default 860 px),
 *               vertical margin below the app header
 *
 * `"palette"` — compact top-aligned card (command palette, quick search)
 *   • Mobile  : edge-to-edge just below header
 *   • Desktop : 480px-wide centred card 1.5rem below header
 *
 * ## What it handles so callers don't have to
 *   - Framer-motion enter/exit (respects `prefers-reduced-motion`)
 *   - Backdrop with `bg-black/40`; click outside → `onClose`
 *   - `Escape` key → `onClose` (via `useModalFocus`)
 *   - Focus trap + focus restore (via `useModalFocus`)
 *   - Safe-area insets on all platforms (via CSS class)
 *   - Soft-keyboard tracking on iOS/Android Tauri via CSS transform
 *     (no mobile-viewport — overlays are fixed and track the visual
 *     viewport naturally; mobile-viewport is only for the main app shell)
 *   - `aria-modal`, `role="dialog"`, `data-modal-focus`
 *
 * ## Usage
 *
 * ```tsx
 * <AppOverlay open={open} onClose={onClose} label="My panel">
 *   {children}
 * </AppOverlay>
 *
 * // Wide modal (like Scheduler):
 * <AppOverlay open={open} onClose={onClose} label="Scheduled tasks" maxWidth="1100px">
 *
 * // Command palette:
 * <AppOverlay open={open} onClose={onClose} label="Command palette" variant="palette">
 * ```
 */

import { type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'

// ─── Types ────────────────────────────────────────────────────────────────────

type OverlayVariant = 'modal' | 'palette'

interface AppOverlayProps {
  open: boolean
  onClose: () => void
  /** Accessible label for the dialog (`aria-label`). */
  label: string
  children: ReactNode

  /** `"modal"` = centred card (default). `"palette"` = compact top-aligned card. */
  variant?: OverlayVariant

  /**
   * Max width of the centred card on desktop (modal variant only).
   * Accepts any CSS width value, e.g. `"860px"` or `"min(90vw,1100px)"`.
   * Default: `"860px"`.
   */
  maxWidth?: string

  /** Extra class names forwarded to the panel element. */
  className?: string

  /**
   * Element to focus when the overlay opens. Defaults to the first focusable
   * element, which is usually the close button — pass the primary control
   * instead so keyboard users start where the work is.
   */
  initialFocus?: React.RefObject<HTMLElement | null>
}

// ─── Animation variants ───────────────────────────────────────────────────────

const MODAL_VARIANTS = {
  hidden:  { opacity: 0, scale: 0.97, y: 6 },
  visible: { opacity: 1, scale: 1,    y: 0 },
  exit:    { opacity: 0, scale: 0.97, y: 6 },
}
const MODAL_VARIANTS_REDUCED = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1 },
  exit:    { opacity: 0 },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AppOverlay({
  open,
  onClose,
  label,
  children,
  variant = 'modal',
  maxWidth = '860px',
  className = '',
  initialFocus,
}: AppOverlayProps) {
  const reduced = useReducedMotion()
  useModalFocus(open, onClose, initialFocus)

  const panelVariants = reduced ? MODAL_VARIANTS_REDUCED : MODAL_VARIANTS

  // Pass sizing token as a CSS variable so media-query rules can reference it.
  const inlineStyle: React.CSSProperties =
    variant === 'modal' ? ({ '--overlay-max-width': maxWidth } as React.CSSProperties) : {}

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — full inset-0 for both variants. No blur; the panel's
              hard edge is the visual boundary. */}
          <motion.div
            key="backdrop"
            data-swipe-ignore
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATIONS_S.fast }}
            className="fixed inset-0 z-40 bg-black/40"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Panel */}
          <motion.div
            key="panel"
            data-swipe-ignore
            role="dialog"
            aria-modal="true"
            aria-label={label}
            data-modal-focus="true"
            data-overlay-variant={variant}
            style={inlineStyle}
            initial={panelVariants.hidden}
            animate={panelVariants.visible}
            exit={panelVariants.exit}
            transition={{
              duration: reduced ? 0.01 : 0.18,
              ease: EASINGS.inOut,
            }}
            className={[
              // ── Shared ──────────────────────────────────────────────────────
              'z-50 flex flex-col overflow-hidden',
              'bg-(--bg-page) shadow-2xl',
              // ── Variant — no mobile-viewport; overlays track the visual
              //   viewport naturally as position:fixed ──────────────────────
              variant === 'modal'   ? 'app-overlay-modal'   : '',
              variant === 'palette' ? 'app-overlay-palette' : '',
              className,
            ].join(' ')}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
