import { Check } from 'lucide-react'
import { type ComponentPropsWithRef } from 'react'

import { cn } from '@/lib/utils'

interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  /** Called with the next checked state. */
  onCheckedChange?: (checked: boolean) => void
  checkClassName?: string
}

function Checkbox({ className, onChange, onCheckedChange, checkClassName, ...props }: CheckboxProps) {
  return (
    <span className="relative inline-flex size-[18px] shrink-0">
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          'peer size-[18px] appearance-none rounded-sm border border-(--color-border-strong) bg-(--bg-page) transition-colors outline-none',
          'checked:border-(--accent-blue) checked:bg-(--accent-blue)',
          'focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 disabled:cursor-not-allowed disabled:opacity-50',
          'aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
          className,
        )}
        onChange={(event) => {
          onCheckedChange?.(event.currentTarget.checked)
          onChange?.(event)
        }}
        {...props}
      />
      <Check
        className={cn(
          'pointer-events-none absolute inset-0 m-auto hidden size-3 text-white peer-checked:block',
          checkClassName,
        )}
        aria-hidden="true"
      />
    </span>
  )
}

export { Checkbox }
