import type { SessionInteractionMode } from '@/api/types'

const MODES: Array<{ value: SessionInteractionMode; label: string }> = [
  { value: 'code', label: 'Code' },
  { value: 'plan', label: 'Plan' },
]

export function SessionModeToggle({
  mode,
  pending = false,
  onChange,
  disabled = false,
}: {
  mode: SessionInteractionMode
  /**
   * True when `mode` is a switch queued behind an active turn. The backend
   * applies it when the turn closes rather than stopping the turn, so the
   * selection is shown as chosen but not yet in force.
   */
  pending?: boolean
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
        const queued = active && pending
        return (
          <button
            key={item.value}
            type="button"
            aria-label={queued ? `${item.label} mode (applies after the current turn)` : `${item.label} mode`}
            aria-pressed={active}
            title={queued ? 'Applies when the current turn finishes' : undefined}
            disabled={disabled || active}
            onClick={() => onChange(item.value)}
            className={`h-8 px-2 text-xs font-medium transition-colors disabled:cursor-default md:h-7 ${
              active
                ? `bg-(--bg-key) text-(--color-text) ${queued ? 'italic opacity-70' : ''}`
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
