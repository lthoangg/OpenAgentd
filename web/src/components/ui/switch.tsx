/**
 * Switch — pill toggle, no external primitives.
 *
 * Rendered as a single <button role="switch"> (the pill track) so it is
 * keyboard-accessible and its parentElement is always the direct DOM parent —
 * matching the old base-ui Switch behaviour that tests rely on.
 *
 * API is a drop-in for the previous base-ui version:
 *   checked, onCheckedChange, disabled, className
 *
 * Feel (DESIGN.md → Motion): the thumb is an absolutely placed 16px pill. While
 * pressed it stretches to 22px toward the side it will travel to (off: grows
 * rightwards from the left, on: leftwards from the right), as an iOS switch
 * does, and on release it slides to its side on ``ease-spring-soft`` at
 * ``base``. It can be dragged: past 4px of travel the side follows the drag
 * direction and releasing sets that side (``onCheckedChange`` only if it
 * changed). A plain click and Space / Enter toggle through ``click``.
 */
import { useRef, useState, type ComponentPropsWithRef, type PointerEvent } from 'react'
import { selectionHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'

interface SwitchProps extends Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'onClick'> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

/** Pointer travel (px) before a press becomes a drag. */
const DRAG_THRESHOLD = 4

function Switch({
  checked = false,
  onCheckedChange,
  disabled,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  ...props
}: SwitchProps) {
  const [pressed, setPressed] = useState(false)
  // The side a drag points at (null while it is a plain press).
  const [dragSide, setDragSide] = useState<boolean | null>(null)
  const gesture = useRef({ startX: 0, moved: false, side: false, suppressClick: false })

  const toggle = (next: boolean) => {
    if (next === checked) return
    selectionHapticFeedback()
    onCheckedChange?.(next)
  }
  const endPress = () => {
    setPressed(false)
    setDragSide(null)
  }

  // The side the thumb sits on (or heads to) right now.
  const side = dragSide ?? checked

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-checked={checked || undefined}
      data-pressed={pressed || undefined}
      data-disabled={disabled || undefined}
      disabled={disabled}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerDown?.(event)
        if (disabled || event.button !== 0) return
        gesture.current = { startX: event.clientX, moved: false, side: checked, suppressClick: false }
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        } catch {
          // A synthetic or already-gone pointer: the press still works without capture.
        }
        setPressed(true)
      }}
      onPointerMove={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerMove?.(event)
        if (!pressed) return
        const dx = event.clientX - gesture.current.startX
        if (!gesture.current.moved && Math.abs(dx) <= DRAG_THRESHOLD) return
        gesture.current.moved = true
        if (dx === 0) return
        const next = dx > 0
        gesture.current.side = next
        setDragSide(next)
      }}
      onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerUp?.(event)
        if (!pressed) return
        const { moved, side: target } = gesture.current
        if (moved) {
          // A drag decides by where it ended; the click that follows it is not a toggle.
          gesture.current.suppressClick = true
          if (!disabled) toggle(target)
        }
        endPress()
      }}
      onPointerCancel={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerCancel?.(event)
        endPress()
      }}
      onClick={(event) => {
        // ``detail`` is 0 for a keyboard-made click, which always toggles.
        if (gesture.current.suppressClick && event.detail !== 0) {
          gesture.current.suppressClick = false
          return
        }
        if (disabled) return
        toggle(!checked)
      }}
      className={cn(
        // Track — a solid pill with no border, like an OS switch
        'relative inline-flex h-[22px] w-10 shrink-0',
        'rounded-full',
        // A horizontal drag moves the thumb; vertical pans still scroll the page.
        'touch-pan-y',
        // Off: the strong border tone as a fill in both themes (the hairline
        // tone left it at 1.5:1 on a paper card, the thumb lost in it); it
        // steps up under the OS "Increase contrast". On: the warm accent
        // (Bark on paper, cream on dark), like a checked box.
        checked ? 'bg-(--switch-on)' : 'bg-(--color-border-strong)',
        // Transitions: the track's colour crossfades while the thumb slides
        'transition-colors duration-(--motion-base) ease-(--ease-in-out)',
        // Touch: a 44px hit area around the 40×22 track, without moving the layout.
        "pointer-coarse:before:absolute pointer-coarse:before:-inset-x-0.5 pointer-coarse:before:-inset-y-[11px] pointer-coarse:before:content-['']",
        // Focus ring
        'focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:ring-offset-1 outline-none',
        // Disabled
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
      {...props}
    >
      {/* Thumb: absolute, so it can grow from the edge it leaves. */}
      <span
        aria-hidden="true"
        className={cn(
          // On, the thumb takes the ink that sits on the accent: white on
          // Bark, near-black on cream.
          'absolute top-[3px] left-[3px] block h-4 rounded-full shadow-(--shadow-depth)',
          checked ? 'bg-(--color-text-on-accent)' : 'bg-(--color-surface) dark:bg-(--color-text)',
          // A slight spring at the end of its travel, like an OS switch. The
          // press stretch animates ``width``: the one layout property we
          // allow (design-lint ``layout-transition``), as it is a 16px dot
          // inside a fixed-size track, so nothing around it re-lays out.
          'transition-[translate,width] duration-(--motion-base) ease-(--ease-spring-soft)',
          // 40px track − 6px padding: the right edge rests at 34px, so a 22px
          // thumb sits at 12px and a 16px one at 18px.
          pressed ? 'w-[22px]' : 'w-4',
          side ? (pressed ? 'translate-x-[12px]' : 'translate-x-[18px]') : 'translate-x-0',
        )}
      />
    </button>
  )
}

export { Switch }
