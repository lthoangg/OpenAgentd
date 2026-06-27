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
      className="mt-2 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-0.5"
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
              'rounded-xs border border-transparent px-2.5 py-1 text-[11px] font-medium transition-colors ' +
              (active
                ? 'border border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
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
