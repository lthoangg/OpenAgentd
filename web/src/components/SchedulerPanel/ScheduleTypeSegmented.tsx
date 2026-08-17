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
      className="inline-flex h-8 max-w-full items-center gap-0.5 overflow-x-auto rounded-sm border border-(--color-border) bg-(--bg-key)/60 p-0.5"
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
            className={`flex h-7 items-center rounded-xs border px-2.5 text-xs font-medium transition-colors ${
              active
                ? 'border-(--color-border-strong) bg-(--bg-card) text-(--color-text) shadow-2xs font-semibold'
                : 'border-transparent text-(--color-text-muted) hover:bg-(--bg-key)/60 hover:text-(--color-text)'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
