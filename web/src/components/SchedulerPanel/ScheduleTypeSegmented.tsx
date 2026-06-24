import type { ScheduledTaskCreate } from '@/api/types'

export function ScheduleTypeSegmented({
  value,
  onChange,
}: {
  value: ScheduledTaskCreate['schedule_type']
  onChange: (v: ScheduledTaskCreate['schedule_type']) => void
}) {
  const options: { key: ScheduledTaskCreate['schedule_type']; label: string }[] = [
    { key: 'every', label: 'Every' },
    { key: 'cron', label: 'Cron' },
    { key: 'at', label: 'At' },
  ]
  return (
    <div
      role="tablist"
      aria-label="Schedule type"
      // ``inline-flex`` (not ``flex w-full``) so the control sizes to its
      // contents — three short labels do not need the full form width.
      className="mt-2 inline-flex gap-1 rounded-md border border-(--color-border) bg-(--bg-page) p-1"
    >
      {options.map((opt) => {
        const active = value === opt.key
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.key)}
            className={
              // Drop ``flex-1`` — let each button hug its label with
              // comfortable horizontal padding instead of stretching to
              // fill the container.
              'rounded-sm px-3 py-1 text-xs font-medium transition-colors ' +
              (active
                ? 'bg-(--bg-card) text-(--color-text) shadow-sm ring-1 ring-(--color-border-strong)'
                : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)')
            }
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
