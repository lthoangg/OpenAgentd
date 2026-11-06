import type { SessionInteractionMode } from '@/api/types'
import { selectionHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'

const LABEL: Record<SessionInteractionMode, string> = { code: 'Code', plan: 'Plan' }
const OTHER: Record<SessionInteractionMode, SessionInteractionMode> = { code: 'plan', plan: 'code' }

/**
 * Code / Plan: one button that names the mode in force; a tap switches to
 * the other (Tab does too, from the message field). One word on the run
 * deck rather than two segments. Code, the default, sits on the keycap
 * wash; Plan takes the selection fill, so it reads at a glance. Both words
 * hold the slot (the other one unseen), so a switch moves nothing beside it.
 * Sized as the deck's other controls (InputComposer → Send).
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
  const other = OTHER[mode]
  const name = `${LABEL[mode]} mode${pending ? ' (applies after the current turn)' : ''}. Switch to ${LABEL[other]}`
  return (
    <button
      type="button"
      aria-label={name}
      title={pending ? 'Applies when the current turn finishes' : undefined}
      // aria-disabled, not disabled: a press on a native disabled button
      // reaches no handler, so focus (and the phone keyboard) would leave
      // the composer.
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return
        selectionHapticFeedback()
        onChange(other)
      }}
      className={cn(
        'relative touch-hit inline-grid shrink-0 place-items-center rounded-sm px-2.5 text-xs font-medium whitespace-nowrap select-none',
        'h-8 md:h-7 pointer-coarse:h-9 phone:text-subhead',
        'transition-colors duration-(--motion-instant) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)',
        mode === 'plan'
          ? 'bg-(--color-fill-selected) text-(--color-text-on-selected)'
          : 'bg-(--bg-key) text-(--color-text-2) hover:text-(--color-text)',
        disabled ? 'cursor-not-allowed opacity-50' : 'pointer-coarse:active:scale-95 motion-reduce:active:scale-100',
        pending && 'italic',
      )}
    >
      {(['code', 'plan'] as const).map((word) => (
        <span
          key={word}
          data-mode-word=""
          aria-hidden="true"
          className={cn('col-start-1 row-start-1', word !== mode && 'invisible')}
        >
          {LABEL[word]}
        </span>
      ))}
    </button>
  )
}
