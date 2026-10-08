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
 */
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
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

function DialogOverlay({ className, closing, ...props }: ComponentPropsWithRef<'div'> & { closing?: boolean }) {
  const { setOpen } = useDialog()
  return (
    <div
      data-slot="dialog-overlay"
      // Dialogs are frequently stacked on top of an already-open mobile
      // drawer (session actions, delete/edit confirmations, etc). Without
      // this, useEdgeSwipe reads any touch-drag on the backdrop as a
      // close-gesture for the drawer underneath and yanks it shut.
      data-swipe-ignore
      className={cn(
        'fixed inset-0 z-50 bg-(--color-overlay)',
        closing
          ? 'animate-out fade-out-0 duration-100'
          : 'animate-in fade-in-0 duration-100',
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
  default: '-mx-4 -mb-4 mt-4 p-4',
  compact: '-mx-3 -mb-3 mt-3 p-3',
  none: '',
} as const

const DialogPaddingContext = createContext<keyof typeof DIALOG_PADDING>('default')

function DialogContent({ className, children, showCloseButton = true, size = 'sm', padding = 'default', ...props }: DialogContentProps) {
  const { open, setOpen, titleId } = useDialog()
  const { mounted, closing } = useDeferredUnmount(open, 100)
  const contentRef = useRef<HTMLDivElement>(null)

  useModalFocus(open && mounted, () => setOpen(false))

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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-full max-w-[calc(100%-2rem)]',
          DIALOG_SIZE[size],
          'max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain',
          'rounded-lg border border-(--color-border) bg-(--bg-card)',
          DIALOG_PADDING[padding],
          'text-sm text-(--color-text) shadow-(--shadow-depth) outline-none',
          closing
            ? 'animate-out fade-out-0 zoom-out-95 duration-100'
            : 'animate-in fade-in-0 zoom-in-95 duration-100',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        {...props}
      >
        <DialogPaddingContext.Provider value={padding}>
          {children}
        </DialogPaddingContext.Provider>
        {showCloseButton && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            onClick={() => setOpen(false)}
            aria-label="Close dialog"
          >
            <X size={14} />
          </Button>
        )}
      </div>
    </DialogPortal>
  )
}

// ─── Semantic sub-parts ──────────────────────────────────────────────────────

function DialogHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
}

function DialogFooter({ className, showCloseButton = false, children, ...props }: ComponentPropsWithRef<'div'> & { showCloseButton?: boolean }) {
  const { setOpen } = useDialog()
  const padding = useContext(DialogPaddingContext)
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 rounded-b-lg border-t border-(--color-border) bg-(--bg-key)/50 sm:flex-row sm:justify-end', FOOTER_BLEED[padding], className)}
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
  return (
    <h2
      id={titleId}
      data-slot="dialog-title"
      className={cn('text-base font-semibold leading-none', className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: ComponentPropsWithRef<'p'>) {
  return (
    <p
      data-slot="dialog-description"
      className={cn('text-sm text-(--color-text-muted)', className)}
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
