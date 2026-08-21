/**
 * Input — OpenAgentd's own primitive.
 *
 * Design language lifted from the inputs in AppBackendDialog:
 *   --bg-input surface · crisp 1px border · text-xs · natural height ·
 *   focus shifts border to --focus-ring with a soft /30 ring · no hover border jump
 *
 * No base-ui. Plain <input> only.
 */
import { type ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

type InputProps = ComponentPropsWithRef<'input'>

function Input({ className, ref, ...props }: InputProps) {
  return (
    <input
      ref={ref}
      data-slot="input"
      className={cn(
        // Layout
        'w-full min-w-0 rounded-sm border',
        // Surface
        'border-(--color-border) bg-(--bg-input)',
        // Typography
        'px-2.5 py-1.5 text-xs text-(--color-text)',
        // Placeholder
        'placeholder:text-(--color-text-muted)/60',
        // Interaction
        'outline-none transition-colors',
        'focus:border-(--focus-ring) focus:ring-2 focus:ring-(--focus-ring)/30',
        // States
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
        // File input
        'file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-(--color-text)',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
export type { InputProps }
