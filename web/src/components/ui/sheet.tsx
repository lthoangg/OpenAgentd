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
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'

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

const sideIn: Record<SheetSide, string> = {
  top:    'slide-in-from-top',
  bottom: 'slide-in-from-bottom',
  left:   'slide-in-from-left',
  right:  'slide-in-from-right',
}
const sideOut: Record<SheetSide, string> = {
  top:    'slide-out-to-top',
  bottom: 'slide-out-to-bottom',
  left:   'slide-out-to-left',
  right:  'slide-out-to-right',
}
const sideLayout: Record<SheetSide, string> = {
  top:    'inset-x-0 top-0 border-b rounded-b-lg',
  bottom: 'inset-x-0 bottom-0 border-t rounded-t-lg',
  left:   'inset-y-0 left-0 h-full w-3/4 max-w-sm border-r rounded-r-lg',
  right:  'inset-y-0 right-0 h-full w-3/4 max-w-sm border-l rounded-l-lg',
}

function SheetContent({ className, children, side = 'right', showCloseButton = true, ...props }: SheetContentProps) {
  const { open, setOpen, titleId } = useSheet()
  const { mounted, closing } = useDeferredUnmount(open, 200)
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

  if (!mounted) return null

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        // Same edge-swipe exclusion rationale as Dialog — a sheet can be
        // open on top of a mobile edge-swipe drawer.
        data-swipe-ignore
        className={cn(
          'fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs duration-200',
          closing ? 'animate-out fade-out-0' : 'animate-in fade-in-0',
        )}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={contentRef}
        data-slot="sheet-content"
        data-swipe-ignore
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'fixed z-50 flex flex-col overflow-y-auto overscroll-contain',
          'border border-(--color-border) bg-(--bg-card)',
          'text-sm text-(--color-text) shadow-md outline-none',
          'duration-200',
          sideLayout[side],
          closing
            ? cn('animate-out fade-out-0', sideOut[side])
            : cn('animate-in fade-in-0', sideIn[side]),
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
