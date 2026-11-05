/**
 * Input — OpenAgentd's own primitive.
 *
 * Design language lifted from the inputs in AppBackendDialog:
 *   --bg-input surface · 1px border hairline · text-xs · natural height ·
 *   focus steps the edge to the subtle text tone (3:1+) · no hover border jump
 *
 * No base-ui. Plain <input> only.
 *
 * An input that turns invalid (``aria-invalid`` goes true) shakes once, like
 * an OS field refusing text (``lib/shake``); one that renders invalid does not.
 */
import { useCallback, useEffect, useRef, type ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'
import { shake } from '@/lib/shake'

type InputProps = ComponentPropsWithRef<'input'>

function Input({ className, ref, ...props }: InputProps) {
  const inner = useRef<HTMLInputElement | null>(null)
  const setRefs = useCallback((node: HTMLInputElement | null) => {
    inner.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }, [ref])
  const invalid = props['aria-invalid'] === true || props['aria-invalid'] === 'true'
  const wasInvalid = useRef(invalid)
  useEffect(() => {
    if (invalid && !wasInvalid.current) shake(inner.current)
    wasInvalid.current = invalid
  }, [invalid])
  return (
    <input
      ref={setRefs}
      data-slot="input"
      // iOS: off by default (most inputs are ids/paths/keys). Prose fields opt
      // in with autoCapitalize="sentences" / autoCorrect="on".
      autoCapitalize="off"
      autoCorrect="off"
      className={cn(
        // Layout
        'w-full min-w-0 rounded-sm border',
        // Surface
        'border-(--color-border) bg-(--bg-input)',
        // Typography
        'px-2.5 py-1.5 text-xs text-(--color-text)',
        // Placeholder
        'placeholder:text-(--color-text-muted)',
        // Interaction
        'outline-none transition-colors focus:outline-none focus-visible:outline-none',
        // A clicked field shows focus the composer's way: a stronger edge,
        // no blue glow (the blue ring marks keyboard focus).
        'focus:border-(--color-text-subtle)',
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
