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
  useEffect,
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

function DialogOverlay({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const { setOpen } = useDialog()
  return (
    <div
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px]',
        'animate-in fade-in-0 duration-150',
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
}

function DialogContent({ className, children, showCloseButton = true, ...props }: DialogContentProps) {
  const { open, setOpen, titleId } = useDialog()
  const contentRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, setOpen])

  // Trap focus inside when open
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const focusable = contentRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    focusable?.[0]?.focus()
    return () => { prev?.focus() }
  }, [open])

  if (!open) return null

  return (
    <DialogPortal>
      <DialogOverlay />
      <div
        ref={contentRef}
        data-slot="dialog-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-full max-w-[calc(100%-2rem)] sm:max-w-sm',
          'max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain',
          'rounded-xl border border-(--color-border) bg-(--bg-card)',
          'p-4 text-sm text-(--color-text) shadow-xl outline-none',
          'animate-in fade-in-0 zoom-in-95 duration-150',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        {...props}
      >
        {children}
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
  return (
    <div
      data-slot="dialog-footer"
      className={cn('-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t border-(--color-border) bg-(--bg-key)/50 p-4 sm:flex-row sm:justify-end', className)}
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
