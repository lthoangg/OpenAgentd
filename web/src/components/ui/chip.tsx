/**
 * Chip — the one small label for states, identifiers and tags (DESIGN.md →
 * Chips). 18px tall, `rounded-xs`, meta size. Four meaning tones plus
 * neutral, one style: a soft tinted fill, never a border (tags such as a
 * transport use the neutral tone). `mono` for identifiers and numbers (`exit 1`,
 * `stdio`, `429 rate_limit`); sans for words (`not yet`, `Vision`).
 *
 * A status chip always carries text: colour is never the only signal. Pass
 * `spinner` for a live state (Running, Starting…) and `dot` for one waiting
 * on someone (Needs you). Words and tones come from `lib/status`.
 */
import type { ComponentPropsWithRef } from 'react'
import { Loader2 } from 'lucide-react'

import type { StatusView } from '@/lib/status'
import { cn } from '@/lib/utils'

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

const SOFT: Record<ChipTone, string> = {
  neutral: 'bg-(--bg-key) text-(--color-text-2)',
  info: 'bg-(--bg-key) text-(--color-text-2)',
  success: 'bg-(--color-success-subtle) text-(--accent-green-text)',
  warning: 'bg-(--color-warning-subtle) text-(--accent-orange-text)',
  error: 'bg-(--color-error-subtle) text-(--color-error)',
}

export interface ChipProps extends ComponentPropsWithRef<'span'> {
  tone?: ChipTone
  /** Monospace text, for identifiers, codes and numbers. */
  mono?: boolean
  /** Leading 5px dot in the text colour, for a state waiting on someone. */
  dot?: boolean
  /** Leading spinner in the text colour, for a live state. Wins over `dot`. */
  spinner?: boolean
}

export function chipClass({ tone = 'neutral', mono = false }: Pick<ChipProps, 'tone' | 'mono'> = {}): string {
  return cn(
    'inline-flex h-[18px] max-w-full shrink-0 items-center gap-1 rounded-xs px-1.5 text-meta leading-none font-medium whitespace-nowrap',
    mono && 'font-mono',
    SOFT[tone],
  )
}

export function Chip({ tone = 'neutral', mono = false, dot = false, spinner = false, className, children, ...props }: ChipProps) {
  return (
    <span data-slot="chip" data-tone={tone} className={cn(chipClass({ tone, mono }), className)} {...props}>
      {spinner ? (
        <Loader2 data-chip-spinner="" size={12} aria-hidden="true" className="shrink-0 animate-spin" />
      ) : (
        dot && <span aria-hidden="true" className="size-[5px] shrink-0 rounded-full bg-current" />
      )}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** A state from the shared vocabulary (`STATUS.done`, `STATUS.running`…) as a chip. */
export function StatusChip({ status, ...props }: Omit<ChipProps, 'tone' | 'spinner' | 'children'> & { status: StatusView }) {
  return (
    <Chip tone={status.tone} spinner={status.spinner} {...props}>
      {status.label}
    </Chip>
  )
}
