/**
 * ContextMeter — the run deck's context ring: how full the context is before
 * older messages are summarized, with the numbers and "Summarize now" behind
 * a click. The percentage drops out when the composer is narrow.
 *
 * It carries no cost: spend shows per turn (the answer footer) and for the
 * last 24 hours (the status bar), and nowhere else.
 */
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { formatCompact } from '@/utils/telemetryFormat'
import { useAgentStore } from '@/stores/useAgentStore'

/** Where the context summarizes when the model's registry entry gives no trigger. */
export const DEFAULT_SUMMARY_TRIGGER_TOKENS = 250_000

export interface ContextMeterProps {
  input: number
  output: number
  cachedPercent?: number
  trigger?: number
  /** "Summarize now" works on an idle session with messages. */
  canSummarize: boolean
}

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function ContextMeter({ input, output, cachedPercent, trigger = DEFAULT_SUMMARY_TRIGGER_TOKENS, canSummarize }: ContextMeterProps) {
  const limit = Math.max(trigger, 1)
  const progress = Math.min(input / limit, 1)
  const percent = Math.round(progress * 100)
  const label = `Context ${percent}% full: ${input.toLocaleString()} of ${limit.toLocaleString()} tokens before older messages are summarized`
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        data-context-meter=""
        className="h-8 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-meta tabular-nums text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) aria-expanded:bg-(--bg-key) aria-expanded:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) md:h-7 pointer-coarse:h-9 pointer-coarse:min-w-9 pointer-coarse:justify-center"
      >
        <svg className="size-4 -rotate-90" viewBox="0 0 18 18" aria-hidden="true">
          {/* A full, visible track: with a faint one, a part-filled ring read
              as a loading spinner rather than a gauge. */}
          <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="var(--color-border-strong)" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r={RADIUS}
            fill="none"
            stroke="var(--color-accent)"
            strokeLinecap="round"
            strokeWidth="2.6"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
          />
        </svg>
        <span className="@max-[520px]:hidden">{percent}%</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-60 gap-2 p-3">
        {/* Labels in the UI font, numbers in mono, as in the turn details. */}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-meta">
          <dt className="text-(--color-text-muted)">Context</dt>
          <dd className="text-right font-mono tabular-nums">{formatCompact(input)} / {formatCompact(limit)} · {percent}%</dd>
          <dt className="text-(--color-text-muted)">Output</dt>
          <dd className="text-right font-mono tabular-nums">{formatCompact(output)}</dd>
          {cachedPercent !== undefined && cachedPercent > 0 && (
            <>
              <dt className="text-(--color-text-muted)">Cached</dt>
              <dd className="text-right font-mono tabular-nums">{cachedPercent.toFixed(0)}%</dd>
            </>
          )}
        </dl>
        <p className="text-meta leading-relaxed text-(--color-text-muted)">
          Older messages are summarized when the context reaches {formatCompact(limit)} tokens.
        </p>
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={!canSummarize}
          onClick={() => { void useAgentStore.getState().compactAgent() }}
        >
          Summarize now
        </Button>
      </PopoverContent>
    </Popover>
  )
}
