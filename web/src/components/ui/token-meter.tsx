/**
 * TokenMeter — compact circular display of current input tokens.
 *
 * The circle keeps the header quiet while still surfacing the value that
 * drives context compaction. Hover/focus/click reveals input/output/cache
 * detail; click covers touch platforms where hover is unavailable.
 */

import { useState } from 'react'

import { cn } from '@/lib/utils'

export const DEFAULT_SUMMARY_TRIGGER_TOKENS = 250_000

export interface TokenMeterProps {
  input: number
  output: number
  cached?: number
  trigger?: number
  pulsing?: boolean
  className?: string
  /** Title attribute override (defaults to a verbose tooltip). */
  title?: string
}

export function TokenMeter({
  input,
  output,
  cached = 0,
  trigger = DEFAULT_SUMMARY_TRIGGER_TOKENS,
  pulsing: _pulsing = false,
  className,
  title,
}: TokenMeterProps) {
  const [open, setOpen] = useState(false)
  const safeTrigger = Math.max(trigger, 1)
  const progress = Math.min(input / safeTrigger, 1)
  const percent = Math.round(progress * 100)
  const ringColor = 'var(--color-accent)'
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - progress)
  const tooltip =
    title ??
    `Input: ${input.toLocaleString()} / ${safeTrigger.toLocaleString()} (${percent}%) · Output: ${output.toLocaleString()}${
      cached > 0 ? ` · Cache: ${cached.toLocaleString()}` : ''
    }`

  return (
    <div
      className={cn('group relative inline-flex items-center', className)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="relative flex h-9 min-w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none md:h-7 md:min-w-7 md:rounded-sm"
        aria-label={tooltip}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <svg className="h-[17px] w-[17px] -rotate-90" viewBox="0 0 18 18" aria-hidden="true">
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeOpacity="0.18"
            strokeWidth="2"
          />
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeLinecap="round"
            strokeWidth="2.6"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
      </button>
      <div
        className={cn(
          'pointer-events-none absolute right-0 top-full z-50 mt-2 min-w-40 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 font-mono text-[11px] leading-5 text-(--color-text) shadow-lg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
          open && 'opacity-100',
        )}
        role="tooltip"
      >
        <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">input</span><span>{input.toLocaleString()}</span></div>
        <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">trigger</span><span>{safeTrigger.toLocaleString()}</span></div>
        <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">used</span><span>{percent}%</span></div>
        <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">output</span><span>{output.toLocaleString()}</span></div>
        <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">cache</span><span>{cached.toLocaleString()}</span></div>
      </div>
    </div>
  )
}
