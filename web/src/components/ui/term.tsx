/**
 * Term — a technical word with its definition on hover (DESIGN.md → Copy:
 * "technical but legible"). Industry terms stay (p95, TTFT, tok/s, stdio,
 * exit code); a dotted underline says a definition is one hover away, and
 * the definition is also the accessible description. Touch shows no
 * tooltip, so surfaces that matter on phones also spell the term out once.
 */
import type { ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Shared definitions, so a term reads the same everywhere. */
export const TERMS = {
  p50: 'Median: half of the values are faster.',
  p95: '95th percentile: 95% of the values are faster, so this is the slow tail.',
  p5: '5th percentile: only 5% of the values are slower.',
  ttft: 'Time to first token: from sending the request to the first streamed token.',
  tokPerSec: 'Output tokens per second, measured after the first token.',
  cacheHit: 'Share of input tokens read from the provider\'s prompt cache, which is cheaper and faster.',
  spendEstimate: 'Estimated from the list prices in the model catalog, not from your bill.',
  stdio: 'The server runs as a local process and talks over standard input and output.',
  http: 'The server is reached over HTTP at a URL.',
  exitCode: 'Process exit status. 0 means success; anything else is a failure.',
  turnDuration: 'Wall-clock time from your message to the end of the agent\'s reply.',
  contextWindow: 'The most tokens the model can read in one request.',
} as const

export type TermKey = keyof typeof TERMS

interface TermProps {
  children: ReactNode
  /** A key of `TERMS`, or a custom definition. */
  definition: TermKey | ReactNode
  className?: string
}

function resolve(definition: TermProps['definition']): ReactNode {
  return typeof definition === 'string' && definition in TERMS ? TERMS[definition as TermKey] : definition
}

export function Term({ children, definition, className }: TermProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        tabIndex={0}
        data-slot="term"
        className={cn(
          'cursor-help underline decoration-(--color-text-subtle) decoration-dotted underline-offset-2',
          className,
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{resolve(definition)}</TooltipContent>
    </Tooltip>
  )
}
