/**
 * Sheet — slide-in panel, zero external primitives.
 *
 * Shares the same context/portal approach as Dialog.
 * Default side is "right"; content slides in from the edge.
 *
 * API (drop-in for the previous base-ui version):
 *   <Sheet open onOpenChange={fn}>
 *     <SheetContent side="right">…</SheetContent>
 *   </Sheet>
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

interface SheetCtx {
  open: boolean
  setOpen: (v: boolean) => void
  titleId: string
}
const SheetContext = createContext<SheetCtx | null>(null)

function useSheet() {
  const ctx = useContext(SheetContext)
  if (!ctx) throw new Error('Sheet sub-components must be inside <Sheet>')
  return ctx
}

// ─── Root ───────────────────────────────────────────────────────────────────

interface SheetProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  children: ReactNode
}

function Sheet({ open: controlledOpen, onOpenChange, defaultOpen = false, children }: SheetProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const titleId = useId()
  const open = controlledOpen ?? uncontrolled
  const setOpen = (v: boolean) => {
    setUncontrolled(v)
    onOpenChange?.(v)
  }
  return (
    <SheetContext.Provider value={{ open, setOpen, titleId }}>
      {children}
    </SheetContext.Provider>
  )
}

// ─── Trigger ────────────────────────────────────────────────────────────────

function SheetTrigger({ children, ...props }: ComponentPropsWithRef<'button'>) {
  const { setOpen } = useSheet()
  return (
    <button type="button" onClick={() => setOpen(true)} {...props}>
      {children}
    </button>
  )
}

// ─── Content ────────────────────────────────────────────────────────────────

type SheetSide = 'top' | 'bottom' | 'left' | 'right'

interface SheetContentProps extends ComponentPropsWithRef<'div'> {
  side?: SheetSide
  showCloseButton?: boolean
}

const sideClasses: Record<SheetSide, string> = {
  top: 'inset-x-0 top-0 border-b rounded-b-xl slide-in-from-top',
  bottom: 'inset-x-0 bottom-0 border-t rounded-t-xl slide-in-from-bottom',
  left: 'inset-y-0 left-0 h-full w-3/4 max-w-sm border-r rounded-r-xl slide-in-from-left',
  right: 'inset-y-0 right-0 h-full w-3/4 max-w-sm border-l rounded-l-xl slide-in-from-right',
}

function SheetContent({ className, children, side = 'right', showCloseButton = true, ...props }: SheetContentProps) {
  const { open, setOpen, titleId } = useSheet()
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, setOpen])

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

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px] animate-in fade-in-0 duration-200"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={contentRef}
        data-slot="sheet-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'fixed z-50 flex flex-col overflow-y-auto overscroll-contain',
          'border border-(--color-border) bg-(--bg-card)',
          'text-sm text-(--color-text) shadow-xl outline-none',
          'animate-in duration-200',
          sideClasses[side],
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        {...props}
      >
        {showCloseButton && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-3 z-10"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X size={14} />
          </Button>
        )}
        {children}
      </div>
    </>,
    document.body,
  )
}

// ─── Semantic sub-parts ──────────────────────────────────────────────────────

function SheetHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />
}

function SheetFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col-reverse gap-2 border-t border-(--color-border) p-4 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: ComponentPropsWithRef<'h2'>) {
  const { titleId } = useSheet()
  return (
    <h2
      id={titleId}
      data-slot="sheet-title"
      className={cn('text-base font-semibold', className)}
      {...props}
    />
  )
}

function SheetDescription({ className, ...props }: ComponentPropsWithRef<'p'>) {
  return (
    <p
      data-slot="sheet-description"
      className={cn('text-sm text-(--color-text-muted)', className)}
      {...props}
    />
  )
}

function SheetClose({ children, ...props }: ComponentPropsWithRef<'button'>) {
  const { setOpen } = useSheet()
  return (
    <button type="button" onClick={() => setOpen(false)} {...props}>
      {children}
    </button>
  )
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
}
