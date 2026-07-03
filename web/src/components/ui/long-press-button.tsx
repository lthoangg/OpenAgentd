import { useState } from 'react'
import type { ComponentPropsWithRef } from 'react'
import { mediumHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { buttonVariants, type ButtonProps } from '@/components/ui/button'
import { useLongPress } from '@/hooks/use-long-press'

interface LongPressButtonProps
  extends ComponentPropsWithRef<'button'>,
    Pick<ButtonProps, 'variant' | 'size'> {
  enabled: boolean
  onLongPress: () => void
}

/**
 * Button with iOS-style press-and-hold affordance for touch input.
 *
 * Pass `variant` + `size` to opt into Button styling.
 * Omit both to get a completely unstyled <button> — safe for nav rows
 * that supply their own className (SessionRow, WorkspaceSessionList).
 *
 * While a touch press is armed the button scales down slightly
 * (mimicking the system context-menu "lift" cue); when the hold
 * threshold is reached it fires a medium haptic and `onLongPress`.
 * Mouse pointers are ignored — desktop keeps plain click semantics.
 */
function LongPressButton({
  enabled,
  onLongPress,
  variant,
  size,
  className,
  ref,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu,
  ...props
}: LongPressButtonProps) {
  const [pressing, setPressing] = useState(false)
  const longPress = useLongPress(
    enabled,
    () => {
      mediumHapticFeedback()
      onLongPress()
    },
    setPressing,
  )

  return (
    <button
      ref={ref}
      {...props}
      data-pressing={pressing || undefined}
      className={cn(
        variant != null ? buttonVariants({ variant, size }) : undefined,
        'data-pressing:scale-[0.97]',
        className,
      )}
      onPointerDown={(event) => { onPointerDown?.(event); longPress.onPointerDown(event) }}
      onPointerMove={(event) => { onPointerMove?.(event); longPress.onPointerMove(event) }}
      onPointerUp={(event) => { onPointerUp?.(event); longPress.onPointerUp(event) }}
      onPointerCancel={(event) => { onPointerCancel?.(event); longPress.onPointerCancel(event) }}
      onPointerLeave={(event) => { onPointerLeave?.(event); longPress.onPointerLeave(event) }}
      onContextMenu={(event) => { onContextMenu?.(event); longPress.onContextMenu(event) }}
    />
  )
}

export { LongPressButton }
