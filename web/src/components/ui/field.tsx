/**
 * Field — label + control + hint/error, the form field used on every panel.
 * Pair fields in grids with `gap-x-4 gap-y-5`.
 *
 * Usage:
 *   <Field label="Name" required error={nameError} hint="…">
 *     <Input … />
 *   </Field>
 */
import { type ReactNode } from 'react'
import { TEXT } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'

interface FieldProps {
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
  /** Stable id used to associate the control with its error text. */
  errorId?: string
  /** Id of the control; renders the label as a `<label>` for it. */
  htmlFor?: string
}

function Field({
  label,
  required,
  className,
  children,
  error,
  hint,
  errorId,
  htmlFor,
}: FieldProps) {
  // Intentionally a <div>, not a <label>. A <label> wrapper causes any
  // click inside it to activate the first focusable control in DOM order —
  // in MultiSelect that means clicking empty space deletes a chip. With
  // `htmlFor` the label is a sibling pointing at one control, which is safe.
  const labelContent = (
    <>
      {label}
      {required && <span className="ml-0.5 text-(--color-error)">*</span>}
    </>
  )
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={TEXT.label}>{labelContent}</label>
      ) : (
        <span className={TEXT.label}>{labelContent}</span>
      )}
      {children}
      {error ? (
        <p id={errorId} className="text-[11px] leading-relaxed text-(--color-error)">{error}</p>
      ) : hint ? (
        <p className={TEXT.hint}>{hint}</p>
      ) : null}
    </div>
  )
}

export { Field }
