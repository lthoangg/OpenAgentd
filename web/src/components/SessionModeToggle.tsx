import type { SessionInteractionMode } from '@/api/types'
import { segmentedItemClass, segmentedTrackClass } from '@/components/ui/segmented-control'
import { cn } from '@/lib/utils'

const MODES: Array<{ value: SessionInteractionMode; label: string }> = [
  { value: 'code', label: 'Code' },
  { value: 'plan', label: 'Plan' },
]

/**
 * Code / Plan switch. Looks like a SegmentedControl but keeps toggle-button
 * semantics: the chosen mode is pressed and disabled, so only the other mode
 * is actionable.
 */
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
      className={segmentedTrackClass({ size: 'composer' })}
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
            className={cn(
              segmentedItemClass({ active, size: 'composer', dimDisabled: !active }),
              queued && 'italic opacity-70',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
