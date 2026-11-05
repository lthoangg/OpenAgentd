/**
 * Telemetry bars are data graphics: they need 3:1 on the card (WCAG 1.4.11).
 * The marker tones reach it solid (token-pairs.test.ts); faded to 55–75%
 * they fell to 1.8–2.8:1.
 */
import { describe, expect, it } from 'bun:test'

import { categoryBarClass } from '@/components/Telemetry/categories'
import type { SpanCategory } from '@/utils/traceTree'

const CATEGORIES: SpanCategory[] = ['agent_run', 'chat', 'tool', 'summarization', 'title', 'goal', 'other']

describe('categoryBarClass', () => {
  it('draws every span bar in its solid marker tone, never faded', () => {
    for (const category of CATEGORIES) {
      for (const error of [false, true]) {
        expect({ category, error, faded: /(?:^|\s)opacity-\d+/.test(categoryBarClass(category, error)) }).toEqual({ category, error, faded: false })
      }
    }
  })
})
