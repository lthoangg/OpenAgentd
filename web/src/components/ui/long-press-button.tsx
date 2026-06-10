import { useRef, useState } from 'react'
import { mediumHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'

const LONG_PRESS_MS = 520
const LONG_PRESS_MOVE_TOLERANCE = 10

interface LongPressButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  enabled: boolean
  onLongPress: () => void
}

/**
 * Button with iOS-style press-and-hold affordance for touch input.
 *
 * While a touch press is armed the button scales down slightly
 * (mimicking the system context-menu "lift" cue); when the hold
 * threshold is reached it fires a medium haptic and ``onLongPress``.
 * Mouse pointers are ignored — desktop keeps plain click semantics.
 */
function LongPressButton({
  enabled,
  onLongPress,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu,
  className,
  ...props
}: LongPressButtonProps) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const [pressing, setPressing] = useState(false)

  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
    setPressing(false)
  }

  return (
    <button
      {...props}
      data-pressing={pressing || undefined}
      className={cn(
        'origin-center transition-transform duration-200 ease-out data-pressing:scale-[0.97] data-pressing:duration-300',
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (!enabled || event.pointerType === 'mouse') return
        startRef.current = { x: event.clientX, y: event.clientY }
        setPressing(true)
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          startRef.current = null
          setPressing(false)
          mediumHapticFeedback()
          onLongPress()
        }, LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        const start = startRef.current
        if (!start) return
        if (
          Math.abs(event.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
        ) {
          clear()
        }
      }}
      onPointerUp={(event) => { onPointerUp?.(event); clear() }}
      onPointerCancel={(event) => { onPointerCancel?.(event); clear() }}
      onPointerLeave={(event) => { onPointerLeave?.(event); clear() }}
      onContextMenu={(event) => {
        onContextMenu?.(event)
        if (enabled) event.preventDefault()
      }}
    />
  )
}

export { LongPressButton }
