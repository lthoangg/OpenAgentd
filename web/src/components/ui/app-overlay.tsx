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
 *   • Desktop : 600px-wide centred card 1.5rem below header
 *
 * ## What it handles so callers don't have to
 *   - Framer-motion enter/exit (respects `prefers-reduced-motion`)
 *   - Backdrop with `bg-(--color-overlay)`; click outside → `onClose`
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
 *
 * ## Header
 *
 * Modal panels open with an ``OverlayHeader``: a 44px ``bg-sidebar`` strip
 * with the title, optional icon / subtitle / actions, and the close button.
 * Settings and Telemetry (which use their own shell) share it too.
 */

import { type ReactNode } from 'react'
import { motion, AnimatePresence, useDragControls, type PanInfo } from 'framer-motion'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { APP_SHORTCUTS, chordOf, type AppShortcutName } from '@/lib/app-shortcuts'
import { useShortcut } from '@/lib/keyboard/hooks'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'

// ─── Header ───────────────────────────────────────────────────────────────────

interface OverlayHeaderProps {
  title: ReactNode
  /** 14px glyph shown before the title. */
  icon?: ReactNode
  /** One line under the title. */
  subtitle?: ReactNode
  /** Controls before the icon/title, e.g. a Back button. */
  leading?: ReactNode
  /** Controls before the close button. */
  actions?: ReactNode
  /** Renders the close button when set. */
  onClose?: () => void
  /** Accessible name of the close button. */
  closeLabel?: string
  /** Tooltip of the close button. */
  closeTooltip?: ReactNode
  className?: string
}

/** Icon button sizing shared by header controls: 44px on touch, 28px on desktop. */
const OVERLAY_HEADER_BUTTON_CLASS = 'md:size-7'

export function OverlayHeader({
  title,
  icon,
  subtitle,
  leading,
  actions,
  onClose,
  closeLabel = 'Close',
  closeTooltip = 'Close (Esc)',
  className,
}: OverlayHeaderProps) {
  return (
    <header
      data-slot="overlay-header"
      className={cn(
        'flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-sidebar) px-2 select-none sm:px-4',
        subtitle != null && 'py-2',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {leading}
        {icon && <span className="flex shrink-0 text-(--color-text-muted)" aria-hidden="true">{icon}</span>}
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-(--color-text)">{title}</h2>
          {subtitle != null && <div className="mt-0.5 truncate text-xs text-(--color-text-muted)">{subtitle}</div>}
        </div>
      </div>
      {(actions || onClose) && (
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {onClose && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={OVERLAY_HEADER_BUTTON_CLASS}
                    onClick={onClose}
                    aria-label={closeLabel}
                  >
                    <X size={14} aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipContent>{closeTooltip}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </header>
  )
}

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

  /**
   * The app shortcut that opens this overlay. Pressing it again closes it:
   * app shortcuts are blocked behind an open overlay, so the toggle has to be
   * a key the overlay's own layer owns.
   */
  toggleShortcut?: AppShortcutName
}

// ─── Animation variants ───────────────────────────────────────────────────────

// Desktop: settles in from 96% on ``ease-out`` at ``base`` (an alert's
// scale), leaves at ``fast``. Phone: a full-screen modal is a sheet, so it
// rises from the bottom edge on the sheet curve and can be pulled back down.
const MODAL_VARIANTS = {
  hidden:  { opacity: 0, scale: 0.96, y: 6 },
  visible: { opacity: 1, scale: 1,    y: 0 },
  exit:    { opacity: 0, scale: 0.96, y: 6 },
}
const SHEET_VARIANTS = {
  hidden:  { opacity: 1, y: '100%' },
  visible: { opacity: 1, y: 0 },
  exit:    { opacity: 1, y: '100%' },
}
const MODAL_VARIANTS_REDUCED = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1 },
  exit:    { opacity: 0 },
}

/** A pull past this, or a flick faster than SHEET_CLOSE_VELOCITY, closes the sheet. */
const SHEET_CLOSE_DISTANCE = 120
const SHEET_CLOSE_VELOCITY = 500

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
  toggleShortcut,
}: AppOverlayProps) {
  const reduced = useReducedMotion()
  const isMobile = useIsMobile()
  const dragControls = useDragControls()
  // An overlay: ⌘K / ⌘P / ⌘, may swap it for another one.
  const layer = useModalFocus(open, onClose, initialFocus, { kind: 'overlay' })
  useShortcut(toggleShortcut ? chordOf(APP_SHORTCUTS[toggleShortcut]) : null, () => { onClose() }, { layer })

  const sheet = isMobile && variant === 'modal' && !reduced
  const panelVariants = reduced ? MODAL_VARIANTS_REDUCED : sheet ? SHEET_VARIANTS : MODAL_VARIANTS
  const panelTransition = reduced
    ? { duration: 0 }
    : sheet
      ? { duration: DURATIONS_S.base, ease: EASINGS.sheet }
      : { duration: DURATIONS_S.base, ease: EASINGS.out }
  const panelExit = reduced
    ? { duration: 0 }
    : { duration: sheet ? DURATIONS_S.base : DURATIONS_S.fast, ease: sheet ? EASINGS.sheet : EASINGS.inOut }

  const onSheetDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > SHEET_CLOSE_DISTANCE || info.velocity.y > SHEET_CLOSE_VELOCITY) onClose()
  }

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
            animate={{ opacity: 1, transition: { duration: DURATIONS_S.base, ease: EASINGS.out } }}
            exit={{ opacity: 0, transition: panelExit }}
            className="fixed inset-0 z-40 bg-(--color-overlay)"
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
            animate={{ ...panelVariants.visible, transition: panelTransition }}
            exit={{ ...panelVariants.exit, transition: panelExit }}
            // Phone sheet: the grabber pulls it down; the body keeps scrolling.
            drag={sheet ? 'y' : false}
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={sheet ? onSheetDragEnd : undefined}
            className={[
              // ── Shared ──────────────────────────────────────────────────────
              'z-50 flex flex-col overflow-hidden',
              'bg-(--bg-page) shadow-(--shadow-depth)',
              // ── Variant — no mobile-viewport; overlays track the visual
              //   viewport naturally as position:fixed ──────────────────────
              variant === 'modal'   ? 'app-overlay-modal'   : '',
              variant === 'palette' ? 'app-overlay-palette' : '',
              className,
            ].join(' ')}
          >
            {sheet && (
              <div
                aria-hidden="true"
                data-slot="sheet-grabber"
                className="absolute inset-x-0 top-0 z-10 flex h-4 cursor-grab touch-none justify-center pt-1.5"
                onPointerDown={(e) => dragControls.start(e)}
              >
                <span className="h-1 w-9 rounded-full bg-(--color-border-strong)" />
              </div>
            )}
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
