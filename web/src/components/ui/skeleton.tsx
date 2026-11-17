import { type ComponentPropsWithRef } from 'react'

import { cn } from '@/lib/utils'

interface SkeletonProps extends ComponentPropsWithRef<'div'> {
  /** Optional accessible label when the skeleton is not purely decorative. */
  'aria-label'?: string
  /**
   * ``page`` (default) sits on the page or a card. ``filled`` sits inside a
   * chip or key already filled with ``--bg-key``, where the page fill would
   * vanish into it.
   */
  tone?: 'page' | 'filled'
}

const TONE = {
  page: 'bg-(--bg-key)/70',
  filled: 'bg-(--color-text-muted)/25',
} as const

function Skeleton({ className, tone = 'page', ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn('oa-breathe rounded-sm', TONE[tone], className)}
      {...props}
    />
  )
}

export { Skeleton }
