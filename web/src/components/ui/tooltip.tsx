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
 * The content panel is role="tooltip" and always rendered in the DOM
 * (visibility toggled via CSS so screen readers can read it).
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
    return cloneElement(renderProp as ReactElement<Record<string, unknown>>, handlers)
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

  const positionClass = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
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
        'transition-opacity duration-150',
        open ? 'opacity-100' : 'opacity-0',
        positionClass,
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
