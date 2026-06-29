/**
 * Popover — zero external primitives.
 *
 * Anchors content below (or above if no space) the trigger via a portal.
 * Positioning uses getBoundingClientRect on open; recalculates on scroll/resize.
 *
 * API (drop-in for the previous base-ui version):
 *   <Popover open? onOpenChange? defaultOpen?>
 *     <PopoverTrigger>…</PopoverTrigger>
 *     <PopoverContent side? align? sideOffset?>…</PopoverContent>
 *   </Popover>
 */
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { cn } from '@/lib/utils'

// ─── Context ────────────────────────────────────────────────────────────────

interface PopoverCtx {
  open: boolean
  setOpen: (v: boolean) => void
  triggerRef: React.RefObject<HTMLElement | null>
  contentId: string
}
const PopoverContext = createContext<PopoverCtx | null>(null)

function usePopover() {
  const ctx = useContext(PopoverContext)
  if (!ctx) throw new Error('Popover sub-components must be inside <Popover>')
  return ctx
}

// ─── Root ───────────────────────────────────────────────────────────────────

interface PopoverProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  children: ReactNode
}

function Popover({ open: controlledOpen, onOpenChange, defaultOpen = false, children }: PopoverProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const contentId = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const open = controlledOpen ?? uncontrolled
  const setOpen = useCallback((v: boolean) => {
    setUncontrolled(v)
    onOpenChange?.(v)
  }, [onOpenChange])
  return (
    <PopoverContext.Provider value={{ open, setOpen, triggerRef, contentId }}>
      {children}
    </PopoverContext.Provider>
  )
}

// ─── Trigger ────────────────────────────────────────────────────────────────

interface PopoverTriggerProps extends ComponentPropsWithRef<'button'> {
  /** Render an arbitrary element as the trigger instead of a <button>. */
  render?: ReactElement
  /** Unused — kept for API compat with previous base-ui version. */
  nativeButton?: boolean
}

function PopoverTrigger({ children, className, render: renderProp, nativeButton: _nb, ref: externalRef, ...props }: PopoverTriggerProps) {
  const { open, setOpen, triggerRef } = usePopover()

  const handlers = {
    'data-slot': 'popover-trigger',
    'aria-expanded': open,
    onClick: () => setOpen(!open),
  }

  if (renderProp && isValidElement(renderProp)) {
    return cloneElement(renderProp as ReactElement<Record<string, unknown>>, {
      ...handlers,
      ref: (el: HTMLElement | null) => {
        (triggerRef as React.MutableRefObject<HTMLElement | null>).current = el
      },
    })
  }

  const setRef = (el: HTMLButtonElement | null) => {
    (triggerRef as React.MutableRefObject<HTMLElement | null>).current = el
    if (typeof externalRef === 'function') externalRef(el)
    else if (externalRef) (externalRef as React.MutableRefObject<HTMLButtonElement | null>).current = el
  }

  return (
    <button
      ref={setRef}
      type="button"
      className={cn('inline-flex', className)}
      {...handlers}
      {...props}
    >
      {children}
    </button>
  )
}

// ─── Content ────────────────────────────────────────────────────────────────

type Side = 'top' | 'bottom' | 'left' | 'right'
type Align = 'start' | 'center' | 'end'

interface PopoverContentProps extends ComponentPropsWithRef<'div'> {
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
}

interface Pos { top: number; left: number }

function computePosition(trigger: DOMRect, content: DOMRect, side: Side, align: Align, sideOffset: number): Pos {
  const gap = sideOffset
  let top: number
  let left: number

  if (side === 'left') {
    left = trigger.left - content.width - gap
    if (left < 0) left = trigger.right + gap
    top = trigger.top
  } else if (side === 'right') {
    left = trigger.right + gap
    if (left + content.width > window.innerWidth) left = trigger.left - content.width - gap
    top = trigger.top
  } else {
    // bottom (default) or top
    const fromBottom = trigger.bottom + gap
    const fromTop = trigger.top - content.height - gap
    top = side === 'top'
      ? (fromTop < 0 ? fromBottom : fromTop)
      : (fromBottom + content.height > window.innerHeight ? fromTop : fromBottom)

    if (align === 'start') left = trigger.left
    else if (align === 'end') left = trigger.right - content.width
    else left = trigger.left + trigger.width / 2 - content.width / 2
    // clamp horizontally
    left = Math.max(8, Math.min(left, window.innerWidth - content.width - 8))
  }

  return { top: top + window.scrollY, left: left + window.scrollX }
}

function PopoverContent({
  className,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 4,
  ...props
}: PopoverContentProps) {
  const { open, setOpen, triggerRef, contentId } = usePopover()
  const contentRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  // Must be called before any conditional returns (Rules of Hooks)
  const { mounted, closing } = useDeferredUnmount(open, 100)

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    const content = contentRef.current
    if (!trigger || !content) return
    setPos(computePosition(trigger.getBoundingClientRect(), content.getBoundingClientRect(), side, align, sideOffset))
  }, [triggerRef, side, align, sideOffset])

  useEffect(() => {
    if (!mounted) return
    reposition()
    window.addEventListener('scroll', reposition, { passive: true, capture: true })
    window.addEventListener('resize', reposition)
    return () => {
      setPos(null)
      window.removeEventListener('scroll', reposition, { capture: true })
      window.removeEventListener('resize', reposition)
    }
  }, [mounted, reposition])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        contentRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, setOpen, triggerRef])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, setOpen])

  if (!mounted) return null

  const anchorWidth = triggerRef.current?.getBoundingClientRect().width ?? 0

  return createPortal(
    <div
      ref={contentRef}
      id={contentId}
      data-slot="popover-content"
      className={cn(
        'fixed z-50 overscroll-contain',
        'flex w-[min(18rem,calc(100vw-1rem))] flex-col gap-2.5',
        'rounded border border-(--color-border) bg-(--bg-card)',
        'p-3.5 text-xs text-(--color-text) shadow-md outline-none',
        'duration-100',
        closing
          ? 'animate-out fade-out-0 zoom-out-95'
          : 'animate-in fade-in-0',
        className,
      )}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        '--anchor-width': `${anchorWidth}px`,
      } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
      {...props}
    >
      {children}
    </div>,
    document.body,
  )
}

// ─── Semantic sub-parts ──────────────────────────────────────────────────────

function PopoverHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div data-slot="popover-header" className={cn('flex flex-col gap-0.5 text-sm', className)} {...props} />
}

function PopoverTitle({ className, ...props }: ComponentPropsWithRef<'h3'>) {
  return <h3 data-slot="popover-title" className={cn('font-semibold text-(--color-text)', className)} {...props} />
}

function PopoverDescription({ className, ...props }: ComponentPropsWithRef<'p'>) {
  return <p data-slot="popover-description" className={cn('text-(--color-text-2)', className)} {...props} />
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger }
