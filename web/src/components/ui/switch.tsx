/**
 * Switch — pill toggle, no external primitives.
 *
 * Rendered as a single <button role="switch"> (the pill track) so it is
 * keyboard-accessible and its parentElement is always the direct DOM parent —
 * matching the old base-ui Switch behaviour that tests rely on.
 *
 * API is a drop-in for the previous base-ui version:
 *   checked, onCheckedChange, disabled, className
 */
import { type ComponentPropsWithRef } from 'react'
import { selectionHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'

interface SwitchProps extends Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'onClick'> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

function Switch({ checked = false, onCheckedChange, disabled, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-checked={checked || undefined}
      data-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        selectionHapticFeedback()
        onCheckedChange?.(!checked)
      }}
      className={cn(
        // Track — a solid pill with no border, like an OS switch
        'relative inline-flex h-[22px] w-10 shrink-0',
        'items-center rounded-full p-[3px]',
        // Off: a hairline tone as a fill, light on paper like a native light
        // switch (the thumb's shadow sets it off) and the strong tone on dark;
        // both step up under the OS "Increase contrast". On: Signal Blue, a
        // deeper one in dark mode so the cream thumb stands off it.
        checked ? 'bg-(--switch-on)' : 'bg-(--color-border) dark:bg-(--color-border-strong)',
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
      {/* Thumb */}
      <span
        aria-hidden="true"
        className={cn(
          'block size-4 rounded-full bg-(--color-surface) shadow-(--shadow-depth) dark:bg-(--color-text)',
          // A slight spring at the end of its travel, like an OS switch.
          'transition-transform duration-(--motion-base) ease-(--ease-spring-soft)',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )}
      />
    </button>
  )
}

export { Switch }
