import { describe, it, expect } from 'bun:test'
import {
  buildSpanTree,
  categorizeSpan,
  computeBounds,
  flattenTree,
  spanBarPosition,
} from '@/utils/traceTree'
import type { SpanDetail } from '@/api/client'

// Minimal factory — only fills the fields the tree code touches.
function span(overrides: Partial<SpanDetail> & Pick<SpanDetail, 'span_id'>): SpanDetail {
  return {
    span_id: overrides.span_id,
    parent_span_id: overrides.parent_span_id ?? null,
    trace_id: overrides.trace_id ?? '0xTRACE',
    name: overrides.name ?? 'span',
    kind: overrides.kind ?? 'INTERNAL',
    start_ms: overrides.start_ms ?? 0,
    end_ms: overrides.end_ms ?? 100,
    duration_ms: overrides.duration_ms ?? 100,
    status: overrides.status ?? 'OK',
    attributes: overrides.attributes ?? {},
  }
}

describe('buildSpanTree', () => {
  it('returns an empty forest for an empty input', () => {
    expect(buildSpanTree([])).toEqual([])
  })

  it('builds a parent/child tree and assigns depth', () => {
    const spans = [
      span({ span_id: 'root', start_ms: 0 }),
      span({ span_id: 'child1', parent_span_id: 'root', start_ms: 10 }),
      span({ span_id: 'child2', parent_span_id: 'root', start_ms: 5 }),
      span({ span_id: 'grand', parent_span_id: 'child1', start_ms: 20 }),
    ]
    const [root] = buildSpanTree(spans)
    expect(root.span.span_id).toBe('root')
    expect(root.depth).toBe(0)
    // Children sorted by start_ms ascending
    expect(root.children.map((c) => c.span.span_id)).toEqual(['child2', 'child1'])
    expect(root.children[0].depth).toBe(1)
    const grand = root.children[1].children[0]
    expect(grand.span.span_id).toBe('grand')
    expect(grand.depth).toBe(2)
  })

  it('promotes spans to roots when the parent is missing (orphans)', () => {
    const spans = [
      span({ span_id: 'orphan', parent_span_id: 'missing', start_ms: 5 }),
      span({ span_id: 'real-root', start_ms: 0 }),
    ]
    const roots = buildSpanTree(spans)
    // Both become roots; order by start_ms
    expect(roots.map((r) => r.span.span_id)).toEqual(['real-root', 'orphan'])
  })

  it('sorts multiple roots by start_ms', () => {
    const spans = [
      span({ span_id: 'b', start_ms: 50 }),
      span({ span_id: 'a', start_ms: 10 }),
    ]
    expect(buildSpanTree(spans).map((r) => r.span.span_id)).toEqual(['a', 'b'])
  })
})

describe('flattenTree', () => {
  it('flattens depth-first in execution order', () => {
    const spans = [
      span({ span_id: 'root', start_ms: 0 }),
      span({ span_id: 'a', parent_span_id: 'root', start_ms: 10 }),
      span({ span_id: 'b', parent_span_id: 'root', start_ms: 20 }),
      span({ span_id: 'a1', parent_span_id: 'a', start_ms: 11 }),
    ]
    const ids = flattenTree(buildSpanTree(spans)).map((n) => n.span.span_id)
    expect(ids).toEqual(['root', 'a', 'a1', 'b'])
  })
})

describe('computeBounds', () => {
  it('returns a zero window for empty input', () => {
    expect(computeBounds([])).toEqual({ start_ms: 0, end_ms: 0, duration_ms: 0 })
  })

  it('spans the earliest start and latest end across all spans', () => {
    const spans = [
      span({ span_id: 'a', start_ms: 100, end_ms: 200 }),
      span({ span_id: 'b', start_ms: 50, end_ms: 150 }),
      span({ span_id: 'c', start_ms: 175, end_ms: 300 }),
    ]
    expect(computeBounds(spans)).toEqual({
      start_ms: 50,
      end_ms: 300,
      duration_ms: 250,
    })
  })
})

describe('spanBarPosition', () => {
  it('normalizes offset and width as percentages of the trace window', () => {
    const bounds = { start_ms: 100, end_ms: 300, duration_ms: 200 }
    const { leftPct, widthPct } = spanBarPosition(
      span({ span_id: 'x', start_ms: 150, end_ms: 200 }),
      bounds,
    )
    expect(leftPct).toBeCloseTo(25, 5) // (150-100)/200 = 25%
    expect(widthPct).toBeCloseTo(25, 5) // (200-150)/200 = 25%
  })

  it('enforces a minimum visible width for zero-duration spans', () => {
    const bounds = { start_ms: 0, end_ms: 1000, duration_ms: 1000 }
    const { widthPct } = spanBarPosition(
      span({ span_id: 'x', start_ms: 500, end_ms: 500 }),
      bounds,
    )
    expect(widthPct).toBeGreaterThan(0)
  })

  it('falls back to full width when the trace window is degenerate', () => {
    const bounds = { start_ms: 0, end_ms: 0, duration_ms: 0 }
    expect(
      spanBarPosition(span({ span_id: 'x', start_ms: 0, end_ms: 0 }), bounds),
    ).toEqual({ leftPct: 0, widthPct: 100 })
  })
})

describe('categorizeSpan', () => {
  it('classifies common span names', () => {
    expect(categorizeSpan('agent_run lead')).toBe('agent_run')
    expect(categorizeSpan('chat gpt-4')).toBe('chat')
    expect(categorizeSpan('execute_tool read')).toBe('tool')
    expect(categorizeSpan('summarization')).toBe('summarization')
    expect(categorizeSpan('summarization_llm_call')).toBe('summarization')
    expect(categorizeSpan('title_generation')).toBe('title')
    expect(categorizeSpan('goal_check')).toBe('goal')
    expect(categorizeSpan('goal_check lead')).toBe('goal')
  })

  it('falls back to "other" for unknown prefixes', () => {
    expect(categorizeSpan('some.random.span')).toBe('other')
    expect(categorizeSpan('')).toBe('other')
  })
})
