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
 * Positioning: content sits above the trigger by default (side="top").
 * A small CSS triangle arrow points toward the trigger.
 *
 * Accessibility: trigger gets aria-describedby pointing at the content.
 */
import {
  createContext,
  useContext,
  useId,
  useState,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type ComponentPropsWithRef,
} from 'react'
import { cn } from '@/lib/utils'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'

// ─── Context ────────────────────────────────────────────────────────────────

interface TooltipCtx {
  id: string
  open: boolean
  setOpen: (v: boolean) => void
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

function Tooltip({ children }: { children: ReactNode }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <TooltipContext.Provider value={{ id, open, setOpen }}>
      <span className="relative inline-flex">{children}</span>
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
      <span className="inline-flex" {...handlers}>
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

interface TooltipContentProps extends ComponentPropsWithRef<'div'> {
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
}

function TooltipContent({ className, side = 'top', children, ...props }: TooltipContentProps) {
  const { id, open } = useTooltip()
  // Deferred unmount so the close animation plays before removal
  const { mounted, closing } = useDeferredUnmount(open, 150)

  if (!mounted) return null

  // Animation classes per side
  const slideIn = {
    top: 'slide-in-from-bottom-1',
    bottom: 'slide-in-from-top-1',
    left: 'slide-in-from-right-1',
    right: 'slide-in-from-left-1',
  }[side]

  // Arrow: a 5×5 rotated square positioned at the edge facing the trigger
  const arrowClass = {
    top: 'bottom-[-3px] left-1/2 -translate-x-1/2',
    bottom: 'top-[-3px] left-1/2 -translate-x-1/2',
    left: 'right-[-3px] top-1/2 -translate-y-1/2',
    right: 'left-[-3px] top-1/2 -translate-y-1/2',
  }[side]

  // Position the panel relative to the trigger via absolute within the Tooltip
  // wrapper (which is `relative inline-flex`)
  const positionClass = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  }[side]

  return (
    <div
      id={id}
      role="tooltip"
      data-slot="tooltip-content"
      className={cn(
        'pointer-events-none absolute z-50 w-max max-w-xs',
        'rounded-md px-2.5 py-1.5 text-xs',
        'bg-(--color-text) text-(--bg-page)',
        'shadow-sm',
        'duration-150',
        closing
          ? 'animate-out fade-out-0 zoom-out-95'
          : `animate-in fade-in-0 zoom-in-95 ${slideIn}`,
        positionClass,
        className,
      )}
      {...props}
    >
      {children}
      {/* CSS arrow triangle */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute size-[6px] rotate-45 bg-(--color-text)',
          arrowClass,
        )}
      />
    </div>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
