/**
 * SettingsField — label + control + hint/error row.
 *
 * Extracted from the identical `Field` function that was copy-pasted into
 * AgentForm/FormFields.tsx and McpServerForm.tsx.
 *
 * Usage:
 *   <SettingsField label="Name" required error={nameError} hint="…">
 *     <Input … />
 *   </SettingsField>
 */
import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SettingsFieldProps {
  /** Visible label text. */
  label: string
  /** Appends a red asterisk after the label. */
  required?: boolean
  /** Extra className on the wrapper div (e.g. `md:col-span-2`). */
  className?: string
  /** The form control(s). */
  children: ReactNode
  /**
   * Zod-sourced validation error. When set it renders in red below the
   * control and suppresses `hint`. Pass `null` or `undefined` to hide.
   */
  error?: string | null
  /** Helper text shown when there is no error. */
  hint?: string | null
}

function SettingsField({
  label,
  required,
  className,
  children,
  error,
  hint,
}: SettingsFieldProps) {
  // Intentionally a <div>, not a <label>. A <label> wrapper causes any
  // click inside it to activate the first focusable control in DOM order —
  // in MultiSelect that means clicking empty space deletes a chip.
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-(--color-text)">
        {label}
        {required && <span className="ml-0.5 text-(--color-error)">*</span>}
      </span>
      {children}
      {error ? (
        <p className="text-[11px] text-(--color-error)">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-(--color-text-muted)">{hint}</p>
      ) : null}
    </div>
  )
}

export { SettingsField }
