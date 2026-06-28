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
      onClick={() => !disabled && onCheckedChange?.(!checked)}
      className={cn(
        // Track — pill shape
        'relative inline-flex h-[22px] w-10 shrink-0',
        'items-center rounded-full border p-[3px]',
        // At rest: warm neutral, visible border
        'border-(--color-border-strong) bg-(--bg-key)',
        // Checked: accent-blue fill, border dissolves
        checked && 'border-(--accent-blue) bg-(--accent-blue)',
        // Transitions
        'transition-colors duration-200',
        // Focus ring
        'focus-visible:ring-2 focus-visible:ring-(--focus-ring)/30 focus-visible:ring-offset-1 outline-none',
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
          'block size-4 rounded-full bg-white shadow-sm',
          'transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )}
      />
    </button>
  )
}

export { Switch }
