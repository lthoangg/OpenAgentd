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
import { buttonVariants } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PopoverRoot } from '@base-ui/react/popover'

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
      className="h-9 w-12 rounded-[8px] border border-(--color-border) bg-(--bg-page) text-center text-sm tabular-nums text-(--color-text) focus:outline-none focus:ring-2 focus:ring-(--focus-ring)/25"
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
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false)

  const handleOpenChange: PopoverRoot.Props['onOpenChange'] = (next) => setOpen(next)

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
          disabled={disabled}
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'h-9 w-full justify-start gap-2 rounded-[10px] border border-(--color-border) bg-(--bg-page) px-3 text-sm font-normal text-(--color-text) hover:border-(--color-border-strong) hover:bg-(--bg-key)',
            !parsed && 'text-(--color-text-muted)',
            triggerClassName,
          )}
        >
          <CalendarIcon className="size-4 shrink-0 opacity-60" />
          <span>{displayLabel}</span>
        </PopoverTrigger>

          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            mode="single"
            selected={parsed}
            onSelect={handleDaySelect}
            disabled={(d) => d < new Date(new Date().setHours(0, 0, 0, 0))}
            autoFocus
          />

          {/* Time + Done row */}
          <div className="flex items-center justify-between gap-4 border-t border-(--color-border) px-4 py-3">
            <div className="flex items-center gap-1">
              <span className="mr-2 text-xs font-medium text-(--color-text-muted)">Time</span>
              <TimeUnit value={hours} min={0} max={23} label="Hours" onChange={handleHours} />
              <span className="mb-0.5 self-center px-0.5 text-base font-semibold text-(--color-text-muted)">:</span>
              <TimeUnit value={minutes} min={0} max={59} label="Minutes" onChange={handleMinutes} />
            </div>

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-[8px] bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-text-on-accent) transition-opacity hover:opacity-90"
            >
              Done
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
