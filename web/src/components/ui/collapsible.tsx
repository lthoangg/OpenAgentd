/**
 * Collapsible — the one height reveal for folds (sidebar sections, Git
 * groups, reader folds, notices). DESIGN.md → Motion: ``base`` on the
 * ``ease-out`` curve, height and opacity together.
 *
 * Height eases through ``grid-template-rows: 0fr ↔ 1fr`` (the technique
 * ``ToolCall/DiffView`` uses): no per-frame measuring, and the content keeps
 * its natural height at rest. Closed content leaves the tab order and the
 * accessibility tree (``inert``), and by default unmounts once the fold has
 * finished closing, so a closed fold costs what ``{open && …}`` cost.
 *
 * A fold that mounts open shows open, with no animation: only a change of
 * ``open`` moves. Reduced motion snaps (the global CSS rule zeroes the
 * transition, and the unmount follows at once).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S } from '@/lib/motion'
import { useDeferredUnmount } from './_use-deferred-unmount'

const BASE_MS = DURATIONS_S.base * 1000

interface CollapsibleProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
  open: boolean
  children: ReactNode
  /** Keep the content mounted while closed (state that must survive a fold). */
  keepMounted?: boolean
  /** Classes for the clipping inner box (padding, borders, layout of the content). */
  innerClassName?: string
}

export function Collapsible({ open, children, keepMounted = false, className, innerClassName, ...props }: CollapsibleProps) {
  const reduced = useReducedMotion() ?? false
  const { mounted } = useDeferredUnmount(open, reduced ? 0 : BASE_MS)
  const [expanded, setExpanded] = useState(open)
  // Clipping is only needed while the rows move; at rest an open fold must
  // not cut off focus outlines or anything that overhangs its content.
  const [moving, setMoving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Opening from closed: the closed rows must be laid out before they change,
  // or the browser has no start value and the fold pops open. Before paint,
  // so the closed frame is never seen.
  useLayoutEffect(() => {
    if (open === expanded) return
    if (open) ref.current?.getBoundingClientRect()
    setExpanded(open)
    setMoving(true)
  }, [open, expanded])
  useEffect(() => {
    if (!moving) return
    const timer = setTimeout(() => setMoving(false), reduced ? 0 : BASE_MS)
    return () => clearTimeout(timer)
  }, [moving, expanded, reduced])

  if (!open && !mounted && !keepMounted) return null
  const shown = open && expanded
  return (
    <div
      ref={ref}
      data-slot="collapsible"
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-(--motion-base) ease-(--ease-out)',
        shown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className,
      )}
      {...props}
    >
      {/* `min-w-0`: a grid item may not shrink below its content by default,
       * so one unbreakable line (a truncated title is still one line) would
       * size the whole fold, and every row in it, past its container.
       * `min-h-0` lets the `0fr` row collapse, so it is only needed closed or
       * moving. At rest it must go: WebKit keeps a `min-height: 0` grid item's
       * old height when the width changes, so wrapped text laid out narrow
       * (a session opening, a panel sliding in) left a gap under it once the
       * transcript widened, until the next relayout. */}
      <div inert={!open} aria-hidden={open ? undefined : true} className={cn('min-w-0', (!shown || moving) && 'min-h-0 overflow-hidden', innerClassName)}>
        {children}
      </div>
    </div>
  )
}
