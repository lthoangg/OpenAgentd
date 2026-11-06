/**
 * PanelRow — one setting: label and description on the left, its control
 * on the right. Stacks on phones, or always with `stack` for controls too wide
 * to sit beside the text (a full-width input, a list). A lone `Switch` never
 * stacks: it sits right of its label at every width, as in iOS Settings.
 *
 *   <PanelRow label="Theme" description="…">
 *     <SegmentedControl … />
 *   </PanelRow>
 *
 * Meant for the flush body of a `PanelSection`, which draws the hairlines
 * between rows.
 */
import { isValidElement, type ReactNode } from 'react'
import { Switch } from '@/components/ui/switch'
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
  const switchRow = !stack && isValidElement(children) && children.type === Switch
  return (
    <div
      className={cn(
        'flex min-h-(--phone-control) md:min-h-14',
        ROW_PAD,
        switchRow
          ? 'flex-row items-center justify-between gap-4 sm:gap-8 md:gap-3'
          : cn('flex-col gap-2 md:gap-3', !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-8'),
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
        {error && <p className="mt-1 text-meta leading-relaxed text-(--color-error)">{error}</p>}
      </div>
      {children !== undefined && (
        <div className={cn('min-w-0', stack ? 'w-full' : 'flex shrink-0 flex-wrap items-center gap-2 sm:justify-end')}>
          {children}
        </div>
      )}
    </div>
  )
}
