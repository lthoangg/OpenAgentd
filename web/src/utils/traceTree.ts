/**
 * Pure helpers for turning a flat list of spans into a renderable waterfall.
 *
 * Kept framework-free so it can be unit-tested in isolation — the React layer
 * just maps over the output.
 */

import type { SpanDetail } from '@/api/client'

/** A span augmented with its child list and depth in the tree. */
export interface SpanNode {
  span: SpanDetail
  depth: number
  children: SpanNode[]
}

/** Summary of the trace's time window — used to normalize bar positions. */
export interface TraceBounds {
  start_ms: number
  end_ms: number
  duration_ms: number
}

/**
 * Build a parent-child forest from the flat span list.
 *
 * Rules:
 *   - Spans with `parent_span_id=null` OR whose parent isn't in the set become
 *     roots (defensive: broken traces still render).
 *   - Children are sorted by `start_ms` ascending so the waterfall reads
 *     top-to-bottom in execution order.
 *   - Roots themselves are also sorted by `start_ms`.
 */
export function buildSpanTree(spans: SpanDetail[]): SpanNode[] {
  const byId = new Map<string, SpanNode>()
  for (const span of spans) {
    byId.set(span.span_id, { span, depth: 0, children: [] })
  }

  const roots: SpanNode[] = []
  for (const node of byId.values()) {
    const parentId = node.span.parent_span_id
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Sort + assign depth by DFS from each root.
  const sortByStart = (a: SpanNode, b: SpanNode) => a.span.start_ms - b.span.start_ms
  const assignDepth = (node: SpanNode, depth: number) => {
    node.depth = depth
    node.children.sort(sortByStart)
    for (const child of node.children) assignDepth(child, depth + 1)
  }
  roots.sort(sortByStart)
  for (const root of roots) assignDepth(root, 0)

  return roots
}

/** Flatten the tree depth-first so the UI can render one row per span. */
export function flattenTree(roots: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = []
  const walk = (node: SpanNode) => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  for (const root of roots) walk(root)
  return out
}

/**
 * Compute the trace-wide time window.  When the list is empty, returns a
 * zero-duration window to avoid NaN in consumers.
 */
export function computeBounds(spans: SpanDetail[]): TraceBounds {
  if (spans.length === 0) {
    return { start_ms: 0, end_ms: 0, duration_ms: 0 }
  }
  let start = spans[0].start_ms
  let end = spans[0].end_ms
  for (const s of spans) {
    if (s.start_ms < start) start = s.start_ms
    if (s.end_ms > end) end = s.end_ms
  }
  return { start_ms: start, end_ms: end, duration_ms: end - start }
}

/**
 * Return the normalized left offset + width (percentages, 0-100) for a span
 * inside the trace window.  Degenerate traces (all spans at the same instant)
 * collapse to a full-width bar so the user still sees *something*.
 */
export function spanBarPosition(
  span: SpanDetail,
  bounds: TraceBounds,
): { leftPct: number; widthPct: number } {
  if (bounds.duration_ms <= 0) {
    return { leftPct: 0, widthPct: 100 }
  }
  const leftPct = ((span.start_ms - bounds.start_ms) / bounds.duration_ms) * 100
  const widthPct = Math.max(
    ((span.end_ms - span.start_ms) / bounds.duration_ms) * 100,
    0.5, // keep 0.5% minimum so zero-duration spans are still visible
  )
  return { leftPct, widthPct }
}

/**
 * Classify spans by name prefix so the UI can color-code them consistently.
 * Falls back to "other" for unknown kinds.
 */
export type SpanCategory = 'agent_run' | 'chat' | 'tool' | 'summarization' | 'title' | 'goal' | 'other'

export function categorizeSpan(name: string): SpanCategory {
  if (name.startsWith('agent_run')) return 'agent_run'
  if (name.startsWith('chat')) return 'chat'
  if (name.startsWith('execute_tool')) return 'tool'
  if (name.startsWith('summarization')) return 'summarization'
  if (name.startsWith('title_generation')) return 'title'
  if (name.startsWith('goal_check')) return 'goal'
  return 'other'
}
