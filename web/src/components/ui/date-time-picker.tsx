/**
 * DateTimePicker — Calendar popover for date + HH / MM inputs for time.
 *
 * UX:
 * - Selecting a day does NOT auto-close — user sets time in the same open panel.
 * - A "Done" button closes the popover intentionally.
 * - Time inputs use text + arrow-key / +/- buttons; native spinners are hidden
 *   to avoid the overlap bug on small widths.
 *
 * Value contract: ISO-8601 local datetime string ("yyyy-MM-dd'T'HH:mm").
 */

import * as React from 'react'
import { format, parse, isValid } from 'date-fns'
import { CalendarIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface DateTimePickerProps {
  /** ISO-8601 local string: "2026-04-23T14:30" or empty string / undefined */
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /** Override classes on the trigger button — useful when embedding in a
   *  drawer where the default `bg-(--bg-key)` clashes with sibling inputs. */
  triggerClassName?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
}

// ── Bare time input (type text, no spinners) ────────────────────────────────

function TimeUnit({
  value,
  min,
  max,
  label,
  onChange,
}: {
  value: number
  min: number
  max: number
  label: string
  onChange: (v: number) => void
}) {
  const wrap = (v: number) => ((v - min + (max - min + 1)) % (max - min + 1)) + min

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowUp') { e.preventDefault(); onChange(wrap(value + 1)) }
    if (e.key === 'ArrowDown') { e.preventDefault(); onChange(wrap(value - 1)) }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, '')
    const n = Math.min(max, Math.max(min, parseInt(raw) || 0))
    onChange(n)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={String(value).padStart(2, '0')}
      onChange={handleChange}
      onKeyDown={handleKey}
      aria-label={label}
      className="h-7 w-10 rounded-xs border border-(--color-border) bg-(--bg-page) text-center text-xs font-mono font-medium tabular-nums text-(--color-text) outline-none transition-colors focus:border-(--focus-ring) focus:ring-1 focus:ring-(--focus-ring)/30"
    />
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export function DateTimePicker({
  value,
  onChange,
  placeholder = 'Pick date & time',
  className,
  triggerClassName,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false)

  const handleOpenChange = (next: boolean) => setOpen(next)

  const parsed = React.useMemo(() => {
    if (!value) return undefined
    const d = parse(value, "yyyy-MM-dd'T'HH:mm", new Date())
    return isValid(d) ? d : undefined
  }, [value])

  const hours = parsed?.getHours() ?? 0
  const minutes = parsed?.getMinutes() ?? 0

  function emitChange(date: Date | undefined, h: number, m: number) {
    if (!date) { onChange(''); return }
    const next = new Date(date)
    next.setHours(h, m, 0, 0)
    onChange(format(next, "yyyy-MM-dd'T'HH:mm"))
  }

  // Selecting a day no longer closes the popover — user finishes with "Done"
  function handleDaySelect(day: Date | undefined) {
    emitChange(day, hours, minutes)
  }

  function handleHours(h: number) { emitChange(parsed, h, minutes) }
  function handleMinutes(m: number) { emitChange(parsed, hours, m) }

  const displayLabel = parsed ? format(parsed, 'dd/MM/yyyy HH:mm') : placeholder

  return (
    <div className={cn('flex items-center', className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          id={id}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          className={cn(
            buttonVariants({ variant: 'default' }),
            'h-8 w-full justify-start gap-2 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 text-xs font-normal text-(--color-text) hover:border-(--color-border-strong) hover:bg-(--bg-key)/50 transition-colors',
            !parsed && 'text-(--color-text-muted)',
            triggerClassName,
          )}
        >
          <CalendarIcon className="size-3.5 shrink-0 text-(--color-text-subtle)" />
          <span className="truncate">{displayLabel}</span>
        </PopoverTrigger>

        <PopoverContent className="w-auto overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card) p-0 shadow-lg" align="start">
          <Calendar
            mode="single"
            selected={parsed}
            onSelect={handleDaySelect}
            disabled={(d) => d < new Date(new Date().setHours(0, 0, 0, 0))}
            autoFocus
          />

          {/* Time + Done row */}
          <div className="flex items-center justify-between gap-3 border-t border-(--color-border) bg-(--bg-sidebar)/60 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-(--color-text-muted)">Time</span>
              <TimeUnit value={hours} min={0} max={23} label="Hours" onChange={handleHours} />
              <span className="self-center font-mono text-xs text-(--color-text-muted)">:</span>
              <TimeUnit value={minutes} min={0} max={59} label="Minutes" onChange={handleMinutes} />
            </div>

            <Button
              type="button"
              size="xs"
              variant="primary"
              onClick={() => setOpen(false)}
              className="h-7 px-3 text-xs"
            >
              Done
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
