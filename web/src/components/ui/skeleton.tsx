import { type ComponentPropsWithRef } from 'react'

import { cn } from '@/lib/utils'

interface SkeletonProps extends ComponentPropsWithRef<'div'> {
  /** Optional accessible label when the skeleton is not purely decorative. */
  'aria-label'?: string
}

function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-sm bg-(--bg-key)/70', className)}
      {...props}
    />
  )
}

export { Skeleton }
