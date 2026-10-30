/**
 * Schedule inputs shared by the create and edit forms. The interval is
 * entered as an amount and a unit ("Every 1 hours") with the raw seconds the
 * backend stores shown beside it; the cron field previews what the
 * expression means and when it fires next, in the task's timezone.
 */
import { useState } from 'react'

import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { isoToWallClock } from '@/utils/format'
import { previewCron } from './cron'
import { FIELD_CLASS, FIELD_ERROR, FIELD_HINT, FIELD_LABEL, INTERVAL_UNITS, splitInterval, type IntervalUnit } from './utils'

export function IntervalField({
  id,
  seconds,
  onChange,
  error,
}: {
  id: string
  seconds: number
  onChange: (seconds: number) => void
  error?: string
}) {
  // The unit is the user's choice, kept while they type ("90" minutes stays minutes).
  const [unit, setUnit] = useState<IntervalUnit>(() => splitInterval(seconds).unit)
  const unitSeconds = INTERVAL_UNITS.find((u) => u.value === unit)?.seconds ?? 1
  const amount = seconds > 0 ? seconds / unitSeconds : 0
  const helpId = `${id}-help`
  const errorId = `${id}-error`

  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>
        Every
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          enterKeyHint="next"
          className={`h-9 w-20 flex-none ${FIELD_CLASS}`}
          type="number"
          inputMode="numeric"
          min="1"
          value={amount ? String(Number(amount.toFixed(4))) : ''}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange(Number.isFinite(n) && n > 0 ? Math.round(n * unitSeconds) : 0)
          }}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : helpId}
        />
        <Dropdown
          value={unit}
          onValueChange={(v) => {
            const next = INTERVAL_UNITS.find((u) => u.value === v)
            if (!next) return
            setUnit(next.value)
            // Keep the number the user typed; change what it counts.
            if (amount > 0) onChange(Math.round(amount * next.seconds))
          }}
          trigger={unit}
          aria-label="Interval unit"
          className="h-9 w-28 flex-none rounded-sm border-(--color-border) bg-(--bg-page) px-2.5 text-xs"
        >
          {INTERVAL_UNITS.map((u) => (
            <DropdownItem key={u.value} value={u.value}>
              {u.label}
            </DropdownItem>
          ))}
        </Dropdown>
        {seconds > 0 && (
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-(--color-text-muted) tabular-nums">= {seconds.toLocaleString('en-US')} s</span>
        )}
      </div>
      {error ? (
        <p id={errorId} className={FIELD_ERROR}>
          {error}
        </p>
      ) : (
        <p id={helpId} className={FIELD_HINT}>
          The first run is one interval after you save.
        </p>
      )}
    </div>
  )
}

export function CronField({
  id,
  value,
  onChange,
  timezone,
  error,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  timezone: string
  error?: string
}) {
  const trimmed = value.trim()
  const preview = trimmed ? previewCron(trimmed, isoToWallClock(new Date().toISOString(), timezone)) : null
  const errorId = `${id}-error`
  const previewId = `${id}-preview`

  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>
        Cron expression
      </label>
      <Input
        id={id}
        enterKeyHint="next"
        className={`h-9 font-mono ${FIELD_CLASS}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * 1-5"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={!!error || (preview !== null && !preview.valid)}
        aria-describedby={error ? errorId : previewId}
      />
      {error ? (
        <p id={errorId} className={FIELD_ERROR}>
          {error}
        </p>
      ) : preview && !preview.valid ? (
        <p id={previewId} className={FIELD_ERROR}>
          Not a valid cron expression yet. Use five fields: minute, hour, day of month, month, day of week.
        </p>
      ) : preview ? (
        <p id={previewId} className={FIELD_HINT}>
          <span className="text-(--color-text-2)">{preview.description ?? 'Custom schedule'}</span>
          {preview.next && (
            <>
              {' · next: '}
              <span className="font-mono text-(--color-text-2)">{preview.next}</span> ({timezone})
            </>
          )}
        </p>
      ) : (
        <p id={previewId} className={FIELD_HINT}>
          Five fields: minute, hour, day of month, month, day of week. <span className="font-mono">0 9 * * 1-5</span> runs on
          weekdays at 09:00.
        </p>
      )}
    </div>
  )
}
