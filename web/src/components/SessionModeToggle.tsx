import type { SessionInteractionMode } from '@/api/types'

const MODES: Array<{ value: SessionInteractionMode; label: string }> = [
  { value: 'code', label: 'Code' },
  { value: 'plan', label: 'Plan' },
]

export function SessionModeToggle({
  mode,
  onChange,
  disabled = false,
}: {
  mode: SessionInteractionMode
  onChange: (mode: SessionInteractionMode) => void
  disabled?: boolean
}) {
  return (
    <div
      aria-label="Interaction mode"
      className="flex shrink-0 overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card)"
      role="group"
    >
      {MODES.map((item) => {
        const active = mode === item.value
        return (
          <button
            key={item.value}
            type="button"
            aria-label={`${item.label} mode`}
            aria-pressed={active}
            disabled={disabled || active}
            onClick={() => onChange(item.value)}
            className={`h-8 px-2 text-xs font-medium transition-colors disabled:cursor-default md:h-7 ${
              active
                ? 'bg-(--bg-key) text-(--color-text)'
                : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-50'
            }`}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
