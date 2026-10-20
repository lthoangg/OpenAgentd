/**
 * PanelRow — one setting: label and description on the left, its control
 * on the right. Stacks on phones, or always with `stack` for controls too wide
 * to sit beside the text (a full-width input, a list).
 *
 *   <PanelRow label="Theme" description="…">
 *     <SegmentedControl … />
 *   </PanelRow>
 *
 * Meant for the flush body of a `PanelSection`, which draws the hairlines
 * between rows.
 */
import { type ReactNode } from 'react'
import { ROW_PAD, TEXT } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'

interface PanelRowProps {
  /** Setting name. */
  label: ReactNode
  /** What the setting does, one or two sentences. */
  description?: ReactNode
  /** Associates the label with a form control. */
  htmlFor?: string
  /** Id for the label, for controls named with `aria-labelledby`. */
  labelId?: string
  /** Put the control under the text at every width. */
  stack?: boolean
  /** Validation message shown under the description. */
  error?: string | null
  /** The control(s). Omit for a text-only row. */
  children?: ReactNode
  className?: string
}

export function PanelRow({
  label,
  description,
  htmlFor,
  labelId,
  stack = false,
  error,
  children,
  className,
}: PanelRowProps) {
  const labelClass = cn('block', TEXT.label)
  return (
    <div
      className={cn(
        'flex min-h-14 flex-col gap-3',
        ROW_PAD,
        !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-8',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label id={labelId} htmlFor={htmlFor} className={labelClass}>{label}</label>
        ) : (
          <p id={labelId} className={labelClass}>{label}</p>
        )}
        {description && <div className={cn('mt-1 max-w-prose', TEXT.hint)}>{description}</div>}
        {error && <p className="mt-1 text-[11px] leading-relaxed text-(--color-error)">{error}</p>}
      </div>
      {children !== undefined && (
        <div className={cn('min-w-0', stack ? 'w-full' : 'flex shrink-0 flex-wrap items-center gap-2 sm:justify-end')}>
          {children}
        </div>
      )}
    </div>
  )
}
