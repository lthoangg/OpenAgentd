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
  /** Keep a small control (a number and its unit) right of the label at every width, as a switch does. */
  inline?: boolean
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
  inline = false,
  error,
  children,
  className,
}: PanelRowProps) {
  const labelClass = cn('block', TEXT.label)
  const switchRow = !stack && (inline || (isValidElement(children) && children.type === Switch))
  const labelEl = htmlFor ? (
    <label id={labelId} htmlFor={htmlFor} className={labelClass}>{label}</label>
  ) : (
    <p id={labelId} className={labelClass}>{label}</p>
  )
  const notes = (
    <>
      {description && <div className={cn('mt-1 max-w-prose', TEXT.hint)}>{description}</div>}
      {error && <p className="mt-1 text-meta leading-relaxed text-(--color-error)">{error}</p>}
    </>
  )
  // A switch, or a number and its unit: on a phone the label and the
  // control share the top line and the description runs the full width
  // under both (iOS's footer), so the control never squeezes the copy into
  // a narrow column. From md up the control spans both lines beside the
  // text, as the flex row draws it.
  if (switchRow && children !== undefined) {
    return (
      <div
        className={cn(
          'grid min-h-(--phone-control) grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:gap-x-8 md:min-h-14 md:gap-x-3',
          ROW_PAD,
          className,
        )}
      >
        <div className="min-w-0">{labelEl}</div>
        <div className="flex shrink-0 items-center justify-end gap-2 md:row-span-2">{children}</div>
        {(description || error) && <div className="col-span-2 min-w-0 md:col-span-1">{notes}</div>}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'flex min-h-(--phone-control) md:min-h-14',
        ROW_PAD,
        'flex-col gap-2 md:gap-3',
        !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-8',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {labelEl}
        {notes}
      </div>
      {children !== undefined && (
        <div className={cn('min-w-0', stack ? 'w-full' : 'flex shrink-0 flex-wrap items-center gap-2 sm:justify-end')}>
          {children}
        </div>
      )}
    </div>
  )
}
