import { useRef } from 'react'
import { softHapticFeedback } from '@/lib/haptics'

const LONG_PRESS_MS = 520
const LONG_PRESS_MOVE_TOLERANCE = 10

interface LongPressButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  enabled: boolean
  onLongPress: () => void
}

function LongPressButton({
  enabled,
  onLongPress,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu,
  ...props
}: LongPressButtonProps) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }

  return (
    <button
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (!enabled || event.pointerType === 'mouse') return
        startRef.current = { x: event.clientX, y: event.clientY }
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          startRef.current = null
          softHapticFeedback()
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
