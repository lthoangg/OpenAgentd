/**
 * Tooltip — zero external primitives.
 *
 * Composes as:
 *   <Tooltip>
 *     <TooltipTrigger>…trigger…</TooltipTrigger>
 *     <TooltipContent>…label…</TooltipContent>
 *   </Tooltip>
 *
 * TooltipTrigger also accepts a `render` prop (a bare element) for cases
 * where the trigger is a non-interactive element that cannot receive an
 * `asChild`-style clone — matching the previous base-ui API.
 *
 * Positioning: content is portaled to `document.body` and positioned with
 * `position: fixed` from the trigger's `getBoundingClientRect()` — so it
 * always renders above every other surface (dialogs, sheets, scrollable
 * panes with `overflow: hidden`) instead of being clipped by an ancestor's
 * overflow or stacking context. It sits above the trigger by default
 * (side="top") and flips to the opposite side, then clamps within the
 * viewport, whenever there isn't room. A small CSS triangle arrow points
 * toward the trigger.
 *
 * Accessibility: trigger gets aria-describedby pointing at the content.
 */
import {
  createContext,
  useContext,
  useId,
  useState,
  useRef,
  useLayoutEffect,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type ComponentPropsWithRef,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'

// ─── Context ────────────────────────────────────────────────────────────────

interface TooltipCtx {
  id: string
  open: boolean
  setOpen: (v: boolean) => void
  anchorRef: RefObject<HTMLSpanElement | null>
}
const TooltipContext = createContext<TooltipCtx | null>(null)

function useTooltip() {
  const ctx = useContext(TooltipContext)
  if (!ctx) throw new Error('Tooltip components must be used inside <Tooltip>')
  return ctx
}

// ─── Provider (no-op shim for API compat) ───────────────────────────────────

function TooltipProvider({ children }: { children: ReactNode; delay?: number }) {
  return <>{children}</>
}

// ─── Root ───────────────────────────────────────────────────────────────────

function Tooltip({ children, className }: { children: ReactNode; className?: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  return (
    <TooltipContext.Provider value={{ id, open, setOpen, anchorRef }}>
      {/* `min-w-0` is a no-op unless this span is itself a flex/grid item —
       * when it is (e.g. a truncated session title inside a flex row), it lets
       * the wrapper shrink instead of forcing the row wider than its parent.
       * `className` lets callers mirror the original element's flex sizing
       * (`min-w-0`, `flex-1`, `shrink-0`, `truncate`, …) onto this wrapper so
       * wrapping a non-button trigger in a Tooltip doesn't change how it
       * participates in the surrounding layout. */}
      <span ref={anchorRef} className={cn('relative inline-flex min-w-0', className)}>{children}</span>
    </TooltipContext.Provider>
  )
}

// ─── Trigger ────────────────────────────────────────────────────────────────

interface TooltipTriggerProps extends ComponentPropsWithRef<'span'> {
  /** Pass a bare element to use as trigger instead of children wrapper. */
  render?: ReactElement
}

function TooltipTrigger({ render: renderProp, children, className, ...props }: TooltipTriggerProps) {
  const { id, setOpen } = useTooltip()
  const handlers = {
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    'aria-describedby': id,
  }

  if (renderProp && isValidElement(renderProp)) {
    // Wrap in a span so hover events work even when the rendered element is
    // a disabled <button> (disabled buttons suppress mouse events in browsers).
    return (
      <span className={cn('inline-flex min-w-0', className)} {...handlers}>
        {cloneElement(renderProp as ReactElement<Record<string, unknown>>, {
          'aria-describedby': id,
        })}
      </span>
    )
  }

  return (
    <span
      className={cn('inline-flex', className)}
      {...handlers}
      {...props}
    >
      {children}
    </span>
  )
}

// ─── Content ────────────────────────────────────────────────────────────────

type Side = 'top' | 'bottom' | 'left' | 'right'

interface TooltipContentProps extends ComponentPropsWithRef<'div'> {
  side?: Side
  sideOffset?: number
}

/** Minimum gap kept between the tooltip box and the viewport edge. */
const VIEWPORT_MARGIN = 8

function TooltipContent({ className, side = 'top', sideOffset = 8, children, ...props }: TooltipContentProps) {
  const { id, open, anchorRef } = useTooltip()
  // Deferred unmount so the close animation plays before removal
  const { mounted, closing } = useDeferredUnmount(open, 150)
  const contentRef = useRef<HTMLDivElement>(null)
  // `placement` is the side actually used after flip-to-fit; `coords` is
  // null until the first measurement lands (avoids painting at `top-left: 0`
  // for a frame — the box stays `invisible` until then).
  const [placement, setPlacement] = useState<Side>(side)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!mounted) {
      setCoords(null)
      return
    }

    function reposition() {
      const anchor = anchorRef.current
      const content = contentRef.current
      if (!anchor || !content) return

      const anchorRect = anchor.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight

      // Flip to the opposite side when the preferred side doesn't have room.
      let next: Side = side
      if (side === 'top' && anchorRect.top - contentRect.height - sideOffset < VIEWPORT_MARGIN) {
        next = 'bottom'
      } else if (side === 'bottom' && anchorRect.bottom + contentRect.height + sideOffset > vh - VIEWPORT_MARGIN) {
        next = 'top'
      } else if (side === 'left' && anchorRect.left - contentRect.width - sideOffset < VIEWPORT_MARGIN) {
        next = 'right'
      } else if (side === 'right' && anchorRect.right + contentRect.width + sideOffset > vw - VIEWPORT_MARGIN) {
        next = 'left'
      }

      let top: number
      let left: number
      if (next === 'top') {
        top = anchorRect.top - contentRect.height - sideOffset
        left = anchorRect.left + anchorRect.width / 2 - contentRect.width / 2
      } else if (next === 'bottom') {
        top = anchorRect.bottom + sideOffset
        left = anchorRect.left + anchorRect.width / 2 - contentRect.width / 2
      } else if (next === 'left') {
        top = anchorRect.top + anchorRect.height / 2 - contentRect.height / 2
        left = anchorRect.left - contentRect.width - sideOffset
      } else {
        top = anchorRect.top + anchorRect.height / 2 - contentRect.height / 2
        left = anchorRect.right + sideOffset
      }

      // Clamp so the box never spills past the viewport edge even when the
      // trigger itself sits flush against one (e.g. the last row of a
      // scrollable list, or a button in the corner of the window).
      left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - contentRect.width - VIEWPORT_MARGIN))
      top = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vh - contentRect.height - VIEWPORT_MARGIN))

      setPlacement(next)
      setCoords({ top, left })
    }

    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, { passive: true, capture: true })
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, { capture: true })
    }
  }, [mounted, side, sideOffset, anchorRef])

  if (!mounted) return null

  // Animation classes per side (post-flip)
  const slideIn = {
    top: 'slide-in-from-bottom-1',
    bottom: 'slide-in-from-top-1',
    left: 'slide-in-from-right-1',
    right: 'slide-in-from-left-1',
  }[placement]

  // Arrow: a 5×5 rotated square positioned at the edge facing the trigger
  const arrowClass = {
    top: 'bottom-[-3px] left-1/2 -translate-x-1/2',
    bottom: 'top-[-3px] left-1/2 -translate-x-1/2',
    left: 'right-[-3px] top-1/2 -translate-y-1/2',
    right: 'left-[-3px] top-1/2 -translate-y-1/2',
  }[placement]

  return createPortal(
    <div
      ref={contentRef}
      id={id}
      role="tooltip"
      data-slot="tooltip-content"
      className={cn(
        'pointer-events-none fixed z-[9999] w-max max-w-xs',
        'rounded-sm px-2 py-1 text-[11px]',
        'bg-(--bg-send) text-(--color-text-on-accent)',
        'shadow-sm',
        // Hide (not unmount) until the first measurement lands, so the box
        // never flashes at (0, 0) before `reposition()` places it.
        !coords && 'invisible',
        closing
          ? 'animate-out fade-out-0 zoom-out-95'
          : `animate-in fade-in-0 zoom-in-95 ${slideIn}`,
        className,
      )}
      style={{ top: coords?.top ?? 0, left: coords?.left ?? 0 }}
      {...props}
    >
      {children}
      {/* CSS arrow triangle */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute size-[6px] rotate-45 bg-(--bg-send)',
          arrowClass,
        )}
      />
    </div>,
    document.body,
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
