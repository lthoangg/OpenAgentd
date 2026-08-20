/**
 * Tailwind class lookups for the span category swatches in the waterfall.
 * Kept separate from the React component so the colour palette is easy to
 * audit at a glance.
 */

import type { SpanCategory } from '@/utils/traceTree'

export function categoryDotClass(cat: SpanCategory): string {
  switch (cat) {
    case 'agent_run':
      return 'bg-(--color-accent)'
    case 'chat':
      return 'bg-(--color-marker-blue)'
    case 'tool':
      return 'bg-(--color-marker-mint)'
    case 'summarization':
      return 'bg-(--color-violet)'
    case 'title':
      return 'bg-(--color-marker-orange)'
    default:
      return 'bg-(--color-text-muted)'
  }
}

export function categoryBarClass(cat: SpanCategory, isError: boolean): string {
  if (isError) return 'bg-(--color-error)'
  switch (cat) {
    case 'agent_run':
      return 'bg-(--color-accent)'
    case 'chat':
      return 'bg-(--color-marker-blue)'
    case 'tool':
      return 'bg-(--color-marker-mint)'
    case 'summarization':
      return 'bg-(--color-violet)'
    case 'title':
      return 'bg-(--color-marker-orange)'
    default:
      return 'bg-(--color-text-muted)'
  }
}
