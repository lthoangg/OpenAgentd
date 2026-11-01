/**
 * Chip — the one small label for states, identifiers and tags (DESIGN.md →
 * Chips). 18px tall, `rounded-xs`, meta size. Four meaning tones plus
 * neutral, one style: a soft tinted fill, never a border (tags such as a
 * transport use the neutral tone). `mono` for identifiers and numbers (`exit 1`,
 * `stdio`, `429 rate_limit`); sans for words (`not yet`, `Vision`).
 *
 * A status chip always carries text: colour is never the only signal. Pass
 * `dot` to add a leading dot for live states (`running`, `ready`).
 */
import type { ComponentPropsWithRef } from 'react'

import { cn } from '@/lib/utils'

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

const SOFT: Record<ChipTone, string> = {
  neutral: 'bg-(--bg-key) text-(--color-text-2)',
  info: 'bg-(--color-info-subtle) text-(--accent-blue-text)',
  success: 'bg-(--color-success-subtle) text-(--accent-green-text)',
  warning: 'bg-(--color-warning-subtle) text-(--accent-orange-text)',
  error: 'bg-(--color-error-subtle) text-(--color-error)',
}

export interface ChipProps extends ComponentPropsWithRef<'span'> {
  tone?: ChipTone
  /** Monospace text, for identifiers, codes and numbers. */
  mono?: boolean
  /** Leading 5px dot in the text colour, for live states. */
  dot?: boolean
}

export function chipClass({ tone = 'neutral', mono = false }: Pick<ChipProps, 'tone' | 'mono'> = {}): string {
  return cn(
    'inline-flex h-[18px] max-w-full shrink-0 items-center gap-1 rounded-xs px-1.5 text-meta leading-none font-medium whitespace-nowrap',
    mono && 'font-mono',
    SOFT[tone],
  )
}

export function Chip({ tone = 'neutral', mono = false, dot = false, className, children, ...props }: ChipProps) {
  return (
    <span data-slot="chip" data-tone={tone} className={cn(chipClass({ tone, mono }), className)} {...props}>
      {dot && <span aria-hidden="true" className="size-[5px] shrink-0 rounded-full bg-current" />}
      <span className="truncate">{children}</span>
    </span>
  )
}
