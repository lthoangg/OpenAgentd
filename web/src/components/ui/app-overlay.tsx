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
 * <AppOverlay open={open} onClose={onClose} label="Scheduled tasks" maxWidth={OVERLAY_MAX_WIDTH.split}>
 *
 * // Command palette:
 * <AppOverlay open={open} onClose={onClose} label="Command palette" variant="palette">
 * ```
 *
 * ## One frame
 *
 * Every modal, Settings and Usage included, is this card: the same gap below
 * the app header and above the status bar, the same border, radius and
 * motion. Only the width differs, by what the overlay holds
 * (`OVERLAY_MAX_WIDTH`). Settings and Usage mount at the app root, outside
 * the chat shell, and say so with `appLevel`.
 *
 * ## Header
 *
 * Modal panels open with an ``OverlayHeader``: a 44px ``bg-sidebar`` strip
 * with the title, optional icon / subtitle / actions, and the close button.
 * On a phone it is the sheet's navigation bar instead: ‹ and the parent's
 * name on the left, the title centred (left-aligned after a ← on Android),
 * the actions and Done on the right, as an iOS sheet reads.
 */

import { type ReactNode } from 'react'
import { motion, AnimatePresence, useDragControls, type PanInfo } from 'framer-motion'
import { ArrowLeft, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CloseButton } from '@/components/ui/close-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SHEET_CLOSE_DISTANCE, SHEET_CLOSE_VELOCITY } from '@/components/ui/_sheet'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
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
  /**
   * Up one level inside the overlay (a Settings section → the list). A
   * phone shows "‹ label" in the accent; elsewhere it is a ← icon button.
   * ``className`` places it (e.g. hidden where a sidebar lists the pages).
   */
  back?: { label: string; onBack: () => void; ariaLabel?: string; tooltip?: ReactNode; className?: string }
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
/**
 * A sheet's bar buttons are bare tint, no fill: iOS dims one when pressed.
 * Drawn at the phone's control step; ``touch-hit`` keeps a 44px target.
 */
const SHEET_BAR_BUTTON_CLASS = 'relative touch-hit h-(--phone-control) min-w-(--phone-control) bg-transparent! text-(--color-accent)! active:opacity-50'

export function OverlayHeader({
  title,
  icon,
  subtitle,
  leading,
  back,
  actions,
  onClose,
  closeLabel = 'Close',
  closeTooltip = 'Close (Esc)',
  className,
}: OverlayHeaderProps) {
  const phone = useIsPhone()
  const android = usePlatform().os === 'android'
  if (phone) {
    const backButton = back && (
      <Button
        type="button"
        variant="ghost"
        size="trigger"
        onClick={back.onBack}
        aria-label={back.ariaLabel ?? `Back to ${back.label}`}
        data-overlay-back=""
        className={cn(SHEET_BAR_BUTTON_CLASS, 'font-normal', android ? 'px-0' : 'max-w-full justify-start gap-0.5 pl-0 pr-2', back.className)}
      >
        {android ? (
          <ArrowLeft size={20} aria-hidden="true" className="size-5" />
        ) : (
          <>
            <ChevronLeft size={20} strokeWidth={2.25} aria-hidden="true" className="-ml-1.5 size-5" />
            <span className="truncate text-xs">{back.label}</span>
          </>
        )}
      </Button>
    )
    return (
      <header
        data-slot="overlay-header"
        data-sheet-bar=""
        className={cn(
          'min-h-(--spacing-app-header) shrink-0 select-none border-b border-(--color-border) bg-(--bg-page) px-2 pt-1.5',
          android ? 'flex items-center gap-2' : 'flex items-center gap-1',
          className,
        )}
      >
        <div className={cn('flex items-center', android ? 'shrink-0' : 'flex-1 justify-start')}>
          {backButton}
          {leading}
        </div>
        <div className={cn('min-w-0', android ? 'flex-1' : 'shrink text-center')}>
          <h2 className="truncate text-base font-semibold text-(--color-text)">{title}</h2>
          {subtitle != null && <div className="truncate text-meta text-(--color-text-muted)">{subtitle}</div>}
        </div>
        <div className={cn('flex items-center justify-end gap-1', android ? 'shrink-0' : 'flex-1')}>
          {actions}
          {onClose && (
            <Button type="button" variant="ghost" size="trigger" onClick={onClose} data-sheet-done="" className={cn(SHEET_BAR_BUTTON_CLASS, 'px-1 text-xs font-semibold')}>
              Done
            </Button>
          )}
        </div>
      </header>
    )
  }
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
        {back && (
          <Tooltip className={back.className}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className={OVERLAY_HEADER_BUTTON_CLASS}
                  onClick={back.onBack}
                  aria-label={back.ariaLabel ?? `Back to ${back.label}`}
                  data-overlay-back=""
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </Button>
              }
            />
            <TooltipContent>{back.tooltip ?? back.ariaLabel ?? `Back to ${back.label}`}</TooltipContent>
          </Tooltip>
        )}
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
            <CloseButton className={OVERLAY_HEADER_BUTTON_CLASS} onClick={onClose} label={closeLabel} tooltip={closeTooltip} />
          )}
        </div>
      )}
    </header>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

type OverlayVariant = 'modal' | 'palette'

/**
 * Max width of a modal by what it holds, so two overlays of one kind are the
 * same width. Pass one as `maxWidth`.
 */
export const OVERLAY_MAX_WIDTH = {
  /** A short reference or form. */
  narrow: '640px',
  /** One column of content. The default. */
  default: '860px',
  /** A list beside its detail (Scheduled tasks). */
  split: '1100px',
  /** A navigated workbench: a sidebar and its pages (Settings, Usage). */
  wide: '76rem',
} as const

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
   * Accepts any CSS width value; prefer an `OVERLAY_MAX_WIDTH` step.
   * Default: `OVERLAY_MAX_WIDTH.default` (`"860px"`).
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

  /**
   * What Escape does, when it is not simply `onClose`: Usage steps out of a
   * trace before it closes. A click on the backdrop and a pull on the phone
   * sheet still `onClose`.
   */
  onEscape?: () => void

  /**
   * `() => false` keeps ⌘K / ⌘P / ⌘, from replacing it: Settings with
   * unsaved changes asks first, and the prompt must not open under another
   * overlay.
   */
  allowSwitch?: () => boolean

  /**
   * Mounted at the app root rather than inside the chat shell (Settings,
   * Usage). On a phone it then fills the visible region and follows the soft
   * keyboard itself; the shell's transform does not carry it (index.css).
   */
  appLevel?: boolean
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

// ─── Component ────────────────────────────────────────────────────────────────

export function AppOverlay({
  open,
  onClose,
  label,
  children,
  variant = 'modal',
  maxWidth = OVERLAY_MAX_WIDTH.default,
  className = '',
  initialFocus,
  toggleShortcut,
  onEscape,
  allowSwitch,
  appLevel = false,
}: AppOverlayProps) {
  const reduced = useReducedMotion()
  const isMobile = useIsMobile()
  const dragControls = useDragControls()
  // An overlay: ⌘K / ⌘P / ⌘, may swap it for another one.
  const layer = useModalFocus(open, onEscape ?? onClose, initialFocus, { kind: 'overlay', allowSwitch })
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
            data-overlay-level={appLevel ? 'app' : undefined}
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
