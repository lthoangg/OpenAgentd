/**
 * MetaRow — the transcript row (DESIGN.md → Transcript rows): the content
 * on the left, a right-aligned 96px meta column for numbers (duration, exit
 * code, counts) so values line up down the transcript. 28px tall, 36px on
 * touch. No icon gutter: the label (a tool name in mono, a plain word)
 * leads the row.
 *
 * Polymorphic on purpose: rows with a details body are buttons, rows
 * without one are plain `div`s so they do not add an empty Tab stop.
 */
import type { ComponentPropsWithRef, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export const META_ROW_GRID =
  'grid w-full min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-sm px-1.5 text-left text-xs pointer-coarse:min-h-9'

/** Right-aligned meta column: tabular mono numbers, muted. */
export const META_COL =
  'flex min-w-24 items-center justify-end gap-1.5 font-mono text-[11px] tabular-nums whitespace-nowrap text-(--color-text-subtle)'

type MetaRowProps = (
  | ({ as?: 'div' } & ComponentPropsWithRef<'div'>)
  | ({ as: 'button' } & ComponentPropsWithRef<'button'>)
) & { meta?: ReactNode }

export function MetaRow({ meta, className, children, ...rest }: MetaRowProps) {
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">{children}</span>
      <span className={META_COL}>{meta}</span>
    </>
  )
  if (rest.as === 'button') {
    const { as: _as, ...props } = rest
    return (
      <button
        type="button"
        {...props}
        className={cn(META_ROW_GRID, 'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60', className)}
      >
        {body}
      </button>
    )
  }
  const { as: _as, ...props } = rest as { as?: 'div' } & ComponentPropsWithRef<'div'>
  return (
    <div {...props} className={cn(META_ROW_GRID, className)}>
      {body}
    </div>
  )
}

/** A duration in the transcript's units: ms under 1 s, then s, then m s. */
export function formatMetaDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${String(s).padStart(2, '0')}s`
}
