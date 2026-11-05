/**
 * Dialog — zero external primitives.
 *
 * Built on a React portal + backdrop div pattern.
 * The native <dialog> element is skipped because it requires imperative
 * .showModal() / .close() calls that conflict with controlled React state;
 * a portal div gives the same stacking-context isolation without the mismatch.
 *
 * API (drop-in for the previous base-ui version):
 *   <Dialog open onOpenChange={fn}>
 *     <DialogTrigger>…</DialogTrigger>
 *     <DialogContent showCloseButton?>…</DialogContent>
 *   </Dialog>
 *
 * Accessibility: focus-trapped inside content while open, Escape closes,
 * click on backdrop closes. aria-modal + role="dialog" + aria-labelledby
 * wired to DialogTitle.
 *
 * A confirm on a phone is an alert (iOS's UIAlertController): a centred card
 * 270px wide, the title and message centred, the actions full-width under a
 * hairline: two side by side with Cancel on the left, three or more stacked
 * with Cancel at the bottom. The destructive action is red text, never a
 * fill, and the card has no ×. Desktop, tablets and Android (whose dialogs
 * end in Material's text buttons) keep the dialog below. A dialog is a confirm
 * when it says so (``alert`` on ``DialogContent``) or looks like one: no ×
 * and nothing but a ``DialogHeader`` and a ``DialogFooter``.
 */
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { getPlatform } from '@/hooks/use-platform'
import { useIsPhone } from '@/hooks/use-is-phone'
import { cn } from '@/lib/utils'
import { DURATIONS_S } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { CloseButton } from '@/components/ui/close-button'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { usePresenceMotion } from '@/components/ui/_use-presence-motion'
import { useModalFocus } from '@/hooks/useModalFocus'

// ─── Context ────────────────────────────────────────────────────────────────

interface DialogCtx {
  open: boolean
  setOpen: (v: boolean) => void
  titleId: string
}
const DialogContext = createContext<DialogCtx | null>(null)

function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('Dialog sub-components must be inside <Dialog>')
  return ctx
}

// ─── Root ───────────────────────────────────────────────────────────────────

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  children: ReactNode
}

function Dialog({ open: controlledOpen, onOpenChange, defaultOpen = false, children }: DialogProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const titleId = useId()
  const open = controlledOpen ?? uncontrolled
  const setOpen = (v: boolean) => {
    setUncontrolled(v)
    onOpenChange?.(v)
  }
  return (
    <DialogContext.Provider value={{ open, setOpen, titleId }}>
      {children}
    </DialogContext.Provider>
  )
}

// ─── Trigger ────────────────────────────────────────────────────────────────

function DialogTrigger({ children, ...props }: ComponentPropsWithRef<'button'>) {
  const { setOpen } = useDialog()
  return (
    <button type="button" onClick={() => setOpen(true)} {...props}>
      {children}
    </button>
  )
}

// ─── Portal + Overlay + Content ──────────────────────────────────────────────

function DialogPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

/** The scrim fades with its dialog, on the dialog's timing. */
const SCRIM_FROM = { opacity: 0 }

function DialogOverlay({ className, closing = false, ...props }: ComponentPropsWithRef<'div'> & { closing?: boolean }) {
  const { setOpen } = useDialog()
  const ref = useRef<HTMLDivElement>(null)
  usePresenceMotion(ref, true, closing, { from: SCRIM_FROM })
  return (
    <div
      ref={ref}
      data-slot="dialog-overlay"
      // Dialogs are frequently stacked on top of an already-open mobile
      // drawer (session actions, delete/edit confirmations, etc). Without
      // this, useEdgeSwipe reads any touch-drag on the backdrop as a
      // close-gesture for the drawer underneath and yanks it shut.
      data-swipe-ignore
      className={cn(
        'fixed inset-0 z-50 bg-(--color-overlay)',
        className,
      )}
      onClick={() => setOpen(false)}
      aria-hidden="true"
      {...props}
    />
  )
}

interface DialogContentProps extends ComponentPropsWithRef<'div'> {
  showCloseButton?: boolean
  /**
   * Width cap from ``sm`` up. A prop rather than a className override:
   * ``cn`` does not merge, and the stylesheet orders ``sm:max-w-sm`` after
   * ``sm:max-w-md``/``-lg``, so a caller's wider class never won.
   */
  size?: keyof typeof DIALOG_SIZE
  /** Panel padding; ``none`` for dialogs that draw their own header strip. */
  padding?: keyof typeof DIALOG_PADDING
  /**
   * What takes focus as the dialog opens (the default button: Enter presses
   * it). Without it, the first control does, which in a footer is Cancel.
   */
  initialFocus?: RefObject<HTMLElement | null>
  /**
   * Present as a phone alert (see the top of the file): ``true`` for a
   * confirm whatever its shape, ``false`` never. Default: a dialog with no ×
   * and nothing but a ``DialogHeader`` and a ``DialogFooter``.
   */
  alert?: boolean
}

const DIALOG_SIZE = {
  xs: 'sm:max-w-xs',
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
  /** Caller sets its own width. */
  none: '',
} as const

const DIALOG_PADDING = {
  default: 'p-4',
  compact: 'p-3',
  none: 'p-0',
} as const

/**
 * Footer bleed per panel padding: the strip cancels the panel padding to reach
 * the edges, and keeps the same distance from the body above it. ``none``
 * panels lay out their own footer.
 */
const FOOTER_BLEED = {
  default: 'mt-5',
  compact: 'mt-4',
  none: '',
} as const

const DIALOG_FROM = { opacity: 0, scale: 0.96 }

const DialogPaddingContext = createContext<keyof typeof DIALOG_PADDING>('default')

/** Whether the dialog around is presented as a phone alert (see the top of the file). */
const DialogAlertContext = createContext(false)

/** The card of a phone alert: UIAlertController's 270pt, narrower on a small screen. */
const ALERT_PANEL = 'w-[270px] max-w-[calc(100%-2rem)] text-center'

/**
 * The alert's actions, whatever buttons the caller passes: plain text on the
 * card, accent for an action and red for a destructive one, Cancel regular
 * weight (a safe confirm, the preferred action, is semibold), a 44px row each
 * with the label wrapping rather than clipping, the press as a wash. The
 * ``!`` on the fill and the ink keeps a variant's own hover from winning.
 */
const ALERT_BUTTONS = [
  '[&>[data-slot=button]]:h-auto [&>[data-slot=button]]:min-h-11 [&>[data-slot=button]]:rounded-none',
  '[&>[data-slot=button]]:py-2 [&>[data-slot=button]]:font-normal [&>[data-slot=button]]:whitespace-normal',
  '[&>[data-slot=button]]:border-(--color-border-subtle) [&>[data-slot=button]]:bg-transparent!',
  '[&>[data-slot=button]]:active:bg-(--bg-key)! [&>[data-slot=button]]:focus-visible:ring-inset',
  '[&>[data-slot=button]:not([data-variant^=danger])]:text-(--color-accent)!',
  '[&>[data-variant^=danger]]:text-(--color-error)!',
  '[&>[data-variant=primary]]:font-semibold',
].join(' ')
/** Two actions share the row, Cancel (first) on the left, a hairline between. */
const ALERT_FOOTER_ROW = 'flex-row [&>[data-slot=button]]:flex-1 [&>[data-slot=button]:not(:first-child)]:border-l'
/** Three or more stack with the first (Cancel) at the bottom, hairlines between. */
const ALERT_FOOTER_STACK = 'flex-col-reverse [&>[data-slot=button]:not(:first-child)]:border-b'

/** A confirm by its shape: a header and a footer, nothing else. */
function isConfirmLayout(children: ReactNode): boolean {
  const parts = Children.toArray(children).filter(isValidElement)
  return parts.length === 2 && parts[0].type === DialogHeader && parts[1].type === DialogFooter
}

function DialogContent({ className, children, showCloseButton = true, size = 'sm', padding = 'default', initialFocus, alert: alertProp, ...props }: DialogContentProps) {
  const { open, setOpen, titleId } = useDialog()
  // Unmount when the ``fast`` exit ends.
  const { mounted, closing } = useDeferredUnmount(open, DURATIONS_S.fast * 1000)
  const contentRef = useRef<HTMLDivElement>(null)
  // Settles in at ``base`` from 96% (an alert's scale), leaves at ``fast``;
  // reopening mid-exit turns back from where it is.
  usePresenceMotion(contentRef, mounted, closing, { from: DIALOG_FROM })

  useModalFocus(open && mounted, () => setOpen(false), initialFocus)

  const phone = useIsPhone()
  // Android's own dialogs are Material's: text buttons in a right-aligned row.
  const alert = phone && getPlatform().os !== 'android' && (alertProp ?? (!showCloseButton && isConfirmLayout(children)))

  if (!mounted) return null

  return (
    <DialogPortal>
      <DialogOverlay closing={closing} />
      <div
        ref={contentRef}
        data-slot="dialog-content"
        data-modal-focus={open ? 'true' : undefined}
        // See DialogOverlay — same edge-swipe exclusion applies to the
        // content itself (e.g. tapping/dragging a footer button).
        data-swipe-ignore
        // Keyboard-aware geometry on the mobile shell (index.css).
        data-dialog-content
        data-alert={alert ? '' : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          alert ? ALERT_PANEL : cn('w-full max-w-[calc(100%-2rem)]', DIALOG_SIZE[size]),
          'max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain',
          alert ? 'rounded-xl' : 'rounded-lg',
          'border border-(--color-border-subtle) bg-(--bg-card)',
          alert ? DIALOG_PADDING.none : DIALOG_PADDING[padding],
          'text-sm text-(--color-text) shadow-(--shadow-depth) outline-none',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        {...props}
      >
        <DialogAlertContext.Provider value={alert}>
          <DialogPaddingContext.Provider value={alert ? 'none' : padding}>
            {children}
          </DialogPaddingContext.Provider>
        </DialogAlertContext.Provider>
        {showCloseButton && !alert && (
          <CloseButton className="absolute top-2 right-2" onClick={() => setOpen(false)} />
        )}
      </div>
    </DialogPortal>
  )
}

// ─── Semantic sub-parts ──────────────────────────────────────────────────────

function DialogHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const alert = useContext(DialogAlertContext)
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col', alert ? 'items-center gap-1 px-4 pt-5 pb-4 text-center' : 'gap-2', className)}
      {...props}
    />
  )
}

/**
 * Children go Cancel first, then the primary action. On wide screens the row
 * follows the host OS: Cancel · Primary (macOS, iOS, Linux), or Primary ·
 * Cancel on Windows. Phones stack them with the primary on top, except
 * Android, whose dialogs end in a row of text buttons (Material). A phone
 * alert is its own layout (see the top of the file).
 */
function DialogFooter({ className, showCloseButton = false, children, ...props }: ComponentPropsWithRef<'div'> & { showCloseButton?: boolean }) {
  const { setOpen } = useDialog()
  const padding = useContext(DialogPaddingContext)
  const alert = useContext(DialogAlertContext)
  const os = getPlatform().os
  const primaryFirst = os === 'windows'
  const textButtons = os === 'android'
  if (alert) {
    const actions = Children.toArray(children).length + (showCloseButton ? 1 : 0)
    return (
      <div
        data-slot="dialog-footer"
        data-button-order="cancel-first"
        data-button-style="alert"
        className={cn(
          'flex border-t border-(--color-border-subtle)',
          actions > 2 ? ALERT_FOOTER_STACK : ALERT_FOOTER_ROW,
          ALERT_BUTTONS,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <Button variant="default" onClick={() => setOpen(false)}>Close</Button>
        )}
      </div>
    )
  }
  return (
    <div
      data-slot="dialog-footer"
      data-button-order={primaryFirst ? 'primary-first' : 'cancel-first'}
      data-button-style={textButtons ? 'text' : 'filled'}
      className={cn(
        textButtons
          ? 'flex flex-row flex-wrap justify-end gap-1'
          : cn('flex flex-col-reverse gap-2', primaryFirst ? 'sm:flex-row-reverse sm:justify-start' : 'sm:flex-row sm:justify-end'),
        FOOTER_BLEED[padding],
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <Button variant="default" onClick={() => setOpen(false)}>Close</Button>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: ComponentPropsWithRef<'h2'>) {
  const { titleId } = useDialog()
  const alert = useContext(DialogAlertContext)
  return (
    <h2
      id={titleId}
      data-slot="dialog-title"
      className={cn('text-base font-semibold', alert ? 'leading-snug' : 'leading-none', className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: ComponentPropsWithRef<'p'>) {
  const alert = useContext(DialogAlertContext)
  return (
    <p
      data-slot="dialog-description"
      // An alert's message is the caption size (``text-meta``: 13px on a phone).
      className={cn(alert ? 'text-meta' : 'text-sm', 'text-(--color-text-muted)', className)}
      {...props}
    />
  )
}

function DialogClose({ children, ...props }: ComponentPropsWithRef<'button'>) {
  const { setOpen } = useDialog()
  return (
    <button type="button" onClick={() => setOpen(false)} {...props}>
      {children}
    </button>
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
