/**
 * The icon action in a turn's own row: Copy and Edit under the prompt, Copy
 * under the answer. A ghost `Button` (24px), muted at rest.
 *
 * A phone draws it 28px so the row fits an iPhone mini; `touch-hit` keeps the
 * touch target 44px around it (36px on a tablet). `Button`'s coarse-pointer
 * floor (index.css, unlayered) would stretch it, so the phone size sets its
 * own floor with `!`.
 *
 * `locked` is for an action that is not available yet: it stays focusable
 * (`aria-disabled`, not `disabled`) so its reason, the `title`, shows on
 * keyboard focus too, and a press does nothing.
 */
import type { MouseEvent } from 'react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const TURN_ACTION_CLASS = 'relative touch-hit max-md:pointer-coarse:size-7 max-md:pointer-coarse:min-h-7! max-md:pointer-coarse:min-w-7!'

const LOCKED_CLASS = 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-(--color-text-muted)'

export function TurnActionButton({ locked = false, className, onClick, ...props }: Omit<ButtonProps, 'variant' | 'size'> & { locked?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-disabled={locked ? true : undefined}
      onClick={locked ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick}
      className={cn(TURN_ACTION_CLASS, locked && LOCKED_CLASS, className)}
      {...props}
    />
  )
}
