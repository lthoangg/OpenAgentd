/**
 * Switch — pill toggle, no external primitives.
 *
 * Built on a visually-hidden <input type="checkbox"> so it is
 * keyboard-accessible and works with native form APIs.
 *
 * API is a drop-in for the previous base-ui version:
 *   checked, onCheckedChange, disabled, className
 */
import { useId, type ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

interface SwitchProps extends Omit<ComponentPropsWithRef<'input'>, 'onChange' | 'type' | 'checked'> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

function Switch({ checked = false, onCheckedChange, disabled, className, id: externalId, ...props }: SwitchProps) {
  const generatedId = useId()
  const id = externalId ?? generatedId

  return (
    <label
      htmlFor={id}
      data-slot="switch"
      data-checked={checked || undefined}
      data-disabled={disabled || undefined}
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
        // Focus ring via peer
        'has-focus-visible:ring-2 has-focus-visible:ring-(--focus-ring)/30 has-focus-visible:ring-offset-1',
        // Disabled
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      {/* Visually hidden native checkbox — accessibility + form compat */}
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className="peer sr-only"
        {...props}
      />
      {/* Thumb */}
      <span
        aria-hidden="true"
        className={cn(
          'block size-4 rounded-full bg-white shadow-sm',
          'transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )}
      />
    </label>
  )
}

export { Switch }
