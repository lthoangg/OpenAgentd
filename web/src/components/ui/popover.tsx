/**
 * Popover — zero external primitives.
 *
 * Anchors content below (or above if no space) the trigger via a portal.
 * Positioning uses getBoundingClientRect on open; recalculates on scroll,
 * resize, and when the content itself changes size. Above its trigger it
 * is held by its bottom edge, so content that shrinks or grows (a search
 * narrowing a list) stays on the trigger instead of hanging off it.
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
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { KeyLayerScope, useKeyLayer } from '@/lib/keyboard/hooks'
import { DURATIONS_S } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { getVisibleViewport, onVisibleViewportChange } from '@/lib/visible-viewport'

// ─── Context ────────────────────────────────────────────────────────────────

interface PopoverCtx {
  open: boolean
  setOpen: (v: boolean) => void
  setTriggerEl: (el: HTMLElement | null) => void
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
  const setTriggerEl = useCallback((el: HTMLElement | null) => {
    triggerRef.current = el
  }, [])
  const open = controlledOpen ?? uncontrolled
  const setOpen = useCallback((v: boolean) => {
    setUncontrolled(v)
    onOpenChange?.(v)
  }, [onOpenChange])
  return (
    <PopoverContext.Provider value={{ open, setOpen, setTriggerEl, triggerRef, contentId }}>
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
  const { open, setOpen, setTriggerEl } = usePopover()

  const handlers = {
    'data-slot': 'popover-trigger',
    'aria-expanded': open,
    onClick: () => setOpen(!open),
  }

  if (renderProp && isValidElement(renderProp)) {
    return cloneElement(renderProp as ReactElement<Record<string, unknown>>, {
      ...handlers,
      ref: (el: HTMLElement | null) => {
        setTriggerEl(el)
      },
    })
  }

  const setRef = (el: HTMLButtonElement | null) => {
    setTriggerEl(el)
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

/** ``above``: ``top`` is where the bottom edge goes (the content is lifted
 *  by its own height), so a change of height keeps it on the trigger. */
interface Pos { top: number; left: number; anchorWidth: number; above: boolean }

function computePosition(trigger: DOMRect, content: DOMRect, side: Side, align: Align, sideOffset: number): Pos {
  const gap = sideOffset
  let top: number
  let left: number
  let above = false

  if (side === 'left') {
    left = trigger.left - content.width - gap
    if (left < 0) left = trigger.right + gap
    top = trigger.top
  } else if (side === 'right') {
    left = trigger.right + gap
    if (left + content.width > window.innerWidth) left = trigger.left - content.width - gap
    top = trigger.top
  } else {
    // bottom (default) or top. Flip against the *visible* area: on iOS the
    // soft keyboard covers the bottom without shrinking ``innerHeight``.
    const visible = getVisibleViewport()
    const fromBottom = trigger.bottom + gap
    const fromTop = trigger.top - content.height - gap
    above = side === 'top' ? fromTop >= visible.top : fromBottom + content.height > visible.bottom
    top = above ? trigger.top - gap : fromBottom

    if (align === 'start') left = trigger.left
    else if (align === 'end') left = trigger.right - content.width
    else left = trigger.left + trigger.width / 2 - content.width / 2
    // clamp horizontally
    left = Math.max(8, Math.min(left, window.innerWidth - content.width - 8))
  }

  return { top: top + window.scrollY, left: left + window.scrollX, anchorWidth: trigger.width, above }
}

const samePos = (a: Pos | null, b: Pos) =>
  a !== null && a.top === b.top && a.left === b.left && a.anchorWidth === b.anchorWidth && a.above === b.above

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
  // Matches the exit's ``animation-duration-(--motion-fast)`` below.
  const { mounted, closing } = useDeferredUnmount(open, DURATIONS_S.fast * 1000)

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    const content = contentRef.current
    if (!trigger || !content) return
    const next = computePosition(trigger.getBoundingClientRect(), content.getBoundingClientRect(), side, align, sideOffset)
    setPos((current) => (samePos(current, next) ? current : next))
  }, [triggerRef, side, align, sideOffset])

  // Placed before the frame that shows it (a layout effect, so the update is
  // synchronous): content that focuses a field on the next frame must find
  // it visible, or WebKit drops the focus.
  useLayoutEffect(() => {
    if (!mounted) return
    reposition()
    window.addEventListener('scroll', reposition, { passive: true, capture: true })
    const stopViewport = onVisibleViewportChange(reposition)
    // Content that changes size may no longer fit on its side, or (aligned
    // to the end or centre) may need to move sideways.
    const content = contentRef.current
    const observer = content && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null
    if (content) observer?.observe(content)
    return () => {
      setPos(null)
      window.removeEventListener('scroll', reposition, { capture: true })
      stopViewport()
      observer?.disconnect()
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

  // Escape closes it while it is the top layer (not the dialog around it).
  // Opening it closes the other menus and popovers; what opens inside it
  // (a dropdown, a dialog) keeps it open (``KeyLayerScope`` below).
  const layer = useKeyLayer(open, { kind: 'transient', onClose: () => setOpen(false) })

  // Closing hands focus back to the trigger when it was inside the popover
  // (or dropped on <body> as the content unmounted), like a native menu.
  useEffect(() => {
    if (!open) return
    const content = contentRef
    const trigger = triggerRef.current
    return () => {
      const active = document.activeElement
      const inside = active instanceof Node && content.current?.contains(active)
      if ((inside || active === document.body || active === null) && trigger?.isConnected) {
        trigger.focus({ preventScroll: true })
      }
    }
  }, [open, triggerRef])

  if (!mounted) return null

  return createPortal(
    <div
      ref={contentRef}
      id={contentId}
      data-slot="popover-content"
      className={cn(
        // The menu layer (ui/context-menu MENU_LAYER_CLASS): above notices.
        'fixed z-70 overscroll-contain',
        'flex w-[min(18rem,calc(100vw-1rem))] flex-col gap-2.5',
        'rounded-md border border-(--color-border-subtle) bg-(--bg-card)',
        'p-3.5 text-xs text-(--color-text) shadow-(--shadow-depth) outline-none',
        // Animation only: ``duration-*`` would also transition ``top``/``left``
        // (``transition-property`` defaults to ``all``) as the content moves
        // from where it mounts, hidden, to where it measures itself into place.
        // DESIGN.md → Motion: in at ``base`` on the ``ease-out`` curve, out at ``fast``.
        'ease-(--ease-out)',
        closing
          ? 'animate-out fade-out-0 zoom-out-95 animation-duration-(--motion-fast)'
          : 'animate-in fade-in-0 animation-duration-(--motion-base)',
        className,
      )}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // ``translate``, not ``transform``: the open/close animation sets
        // ``transform`` and would undo the lift while it ran.
        translate: pos?.above ? '0 -100%' : undefined,
        visibility: pos ? 'visible' : 'hidden',
        '--anchor-width': `${pos?.anchorWidth ?? 0}px`,
      } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
      {...props}
    >
      <KeyLayerScope layer={layer}>{children}</KeyLayerScope>
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
