/**
 * Span types in the trace waterfall: a short word per category (the chip
 * and the legend say the same thing) and the colour of its swatch and bar.
 * Colour carries the type; an error always turns red and says "error" too.
 */

import { chipClass } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import type { SpanCategory } from '@/utils/traceTree'

/** Legend order. */
export const CATEGORY_ORDER: SpanCategory[] = ['agent_run', 'chat', 'tool', 'goal', 'summarization', 'title', 'other']

const LABELS: Record<SpanCategory, string> = {
  agent_run: 'agent',
  chat: 'llm',
  tool: 'tool',
  goal: 'goal',
  summarization: 'summary',
  title: 'title',
  other: 'span',
}

const DESCRIPTIONS: Record<SpanCategory, string> = {
  agent_run: 'One agent run: the whole turn, or a sub-agent inside it.',
  chat: 'One model call.',
  tool: 'One tool call.',
  goal: 'A goal completion check.',
  summarization: 'Context summarization before a model call.',
  title: 'Session title generation.',
  other: 'Any other span.',
}

export function categoryLabel(cat: SpanCategory): string {
  return LABELS[cat]
}

export function categoryDescription(cat: SpanCategory): string {
  return DESCRIPTIONS[cat]
}

export function categoryDotClass(cat: SpanCategory): string {
  switch (cat) {
    case 'agent_run':
      return 'bg-(--color-violet)'
    case 'chat':
      return 'bg-(--color-marker-blue)'
    case 'tool':
      return 'bg-(--color-text-muted)'
    case 'goal':
      return 'bg-(--color-marker-orange)'
    case 'summarization':
      return 'bg-(--color-marker-mint)'
    case 'title':
      return 'bg-(--color-marker-pink)'
    default:
      return 'bg-(--color-text-subtle)'
  }
}

export function categoryBarClass(cat: SpanCategory, isError: boolean): string {
  if (isError) return 'bg-(--color-error)'
  return cn(categoryDotClass(cat), cat === 'agent_run' ? 'opacity-55' : 'opacity-75')
}

/** The type chip on a waterfall row and in the legend: swatch + word. */
export function SpanTypeChip({ category, error = false }: { category: SpanCategory; error?: boolean }) {
  return (
    <span
      data-slot="chip"
      data-tone={error ? 'error' : 'neutral'}
      className={cn(chipClass({ variant: 'outline', mono: true, tone: error ? 'error' : 'neutral' }), 'w-[4.75rem] justify-start')}
    >
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-[1px]', error ? 'bg-(--color-error)' : categoryDotClass(category))} />
      {categoryLabel(category)}
    </span>
  )
}
