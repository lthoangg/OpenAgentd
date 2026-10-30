/**
 * Pure derivations for the telemetry overview: labels, per-day series, and
 * the handful of headline numbers. Kept out of the components so they are
 * easy to test and every view agrees on the definitions.
 */
import type { ObservabilitySummary, SessionUsage, SpanDetail } from '@/api/client'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { pathBasename } from '@/utils/workspace'

/** Label for a workspace root; ``null`` is a turn recorded before v3.0.0. */
export function workspaceName(path: string | null): string {
  if (path === null) return 'Unknown workspace'
  if (isChatWorkspacePath(path)) return 'Chat'
  return pathBasename(path)
}

/** ``provider:model`` → the model part (provider shows in the tooltip). */
export function modelName(providerModel: string): string {
  const index = providerModel.indexOf(':')
  return index >= 0 ? providerModel.slice(index + 1) : providerModel
}

/** Display name for a ``by_session`` row: its title, else what it was. */
export function sessionName(row: Pick<SessionUsage, 'title' | 'deleted' | 'parent_session_id' | 'agent_name'>): string {
  if (row.title) return row.title
  if (row.deleted) return 'Deleted session'
  if (row.parent_session_id) return row.agent_name ? `${row.agent_name} sub-agent` : 'Sub-agent'
  return 'Untitled session'
}

/**
 * Session ids compare across the stored (hex) and API (hyphenated) forms:
 * spans record the id as the runner held it, while ``parent_session_id``
 * comes from the database in the API form.
 */
export function sessionKey(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

export interface NestedSession {
  row: SessionUsage
  /** 0 for a session that started on its own, 1 for its sub-agents, and so on. */
  depth: number
}

/**
 * ``by_session`` rows with each sub-agent session listed under the session
 * that started it, keeping the backend's ranking among siblings. A
 * sub-agent whose parent is not in the list stays where it ranked.
 */
export function nestSessions(rows: SessionUsage[]): NestedSession[] {
  const present = new Set(rows.map((row) => sessionKey(row.session_id)))
  const children = new Map<string, SessionUsage[]>()
  const roots: SessionUsage[] = []
  for (const row of rows) {
    const parent = row.parent_session_id ? sessionKey(row.parent_session_id) : null
    if (parent !== null && present.has(parent) && parent !== sessionKey(row.session_id)) {
      children.set(parent, [...(children.get(parent) ?? []), row])
    } else {
      roots.push(row)
    }
  }
  const nested: NestedSession[] = []
  const seen = new Set<string>()
  const visit = (row: SessionUsage, depth: number) => {
    const key = sessionKey(row.session_id)
    if (seen.has(key)) return
    seen.add(key)
    nested.push({ row, depth })
    for (const child of children.get(key) ?? []) visit(child, depth + 1)
  }
  for (const row of roots) visit(row, 0)
  // Rows whose recorded parents form a cycle never hang off a root; keep them.
  for (const row of rows) visit(row, 0)
  return nested
}

export interface DayPoint {
  /** ``YYYY-MM-DD`` (UTC, matching the backend buckets). */
  day: string
  turns: number
  failed: number
  cost: number
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * One point per UTC day from the window start to its end, zero-filled so the
 * chart's x-axis is continuous even on quiet days.
 */
export function dailySeries(summary: ObservabilitySummary): DayPoint[] {
  const byDay = new Map(summary.daily_turns.map((d) => [d.day, d]))
  const start = new Date(summary.window_start)
  const end = new Date(summary.window_end)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return summary.daily_turns.map((d) => ({ day: d.day, turns: d.turns, failed: d.errors, cost: d.estimated_cost_usd ?? 0 }))
  }
  const points: DayPoint[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
  const last = utcDay(end)
  // Bounded by the 90-day API maximum; the guard only protects bad input.
  for (let i = 0; i < 400; i += 1) {
    const day = utcDay(cursor)
    const d = byDay.get(day)
    points.push({ day, turns: d?.turns ?? 0, failed: d?.errors ?? 0, cost: d?.estimated_cost_usd ?? 0 })
    if (day >= last) break
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return points
}

export interface Headline {
  spend: number
  spendPerTurn: number
  turns: number
  failedTurns: number
  turnP50: number
  turnP95: number
  /** Time to first streamed output of an LLM call (ms); 0 when unmeasured. */
  ttftP50: number
  ttftP95: number
  /** Output tokens per second: median and the slow 5th percentile. */
  tpsP50: number
  tpsP5: number
  inputTokens: number
  outputTokens: number
  cachePercent: number
  cachedTokens: number
}

export function headline(summary: ObservabilitySummary): Headline {
  const { totals, latency_ms: latency } = summary
  const failedTurns = summary.daily_turns.reduce((sum, d) => sum + d.errors, 0)
  return {
    spend: totals.estimated_cost_usd,
    spendPerTurn: totals.turns > 0 ? totals.estimated_cost_usd / totals.turns : 0,
    turns: totals.turns,
    failedTurns,
    turnP50: latency.turn_p50,
    turnP95: latency.turn_p95,
    ttftP50: latency.ttft_p50 ?? 0,
    ttftP95: latency.ttft_p95 ?? 0,
    tpsP50: summary.output_tps?.p50 ?? 0,
    tpsP5: summary.output_tps?.p5 ?? 0,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    cachePercent: totals.cache_percent,
    cachedTokens: totals.cached_tokens,
  }
}

/** Share of ``part`` in ``total`` as a 0–100 width, never NaN. */
export function sharePct(part: number, total: number): number {
  if (!(total > 0) || !(part > 0)) return 0
  return Math.min(100, (part / total) * 100)
}

/** Conversation id the backend records for runs outside a session. */
const NO_SESSION = 'no-session'
/** Mirrors the backend's ``WORKSPACE_ATTR`` on ``agent_run`` spans. */
const WORKSPACE_ATTR = 'openagentd.workspace'

function attrString(attrs: Record<string, unknown>, key: string): string | null {
  const value = attrs[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function attrNumber(attrs: Record<string, unknown>, key: string): number {
  const raw = attrs[key]
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : 0
}

export interface TraceSummary {
  startMs: number
  durationMs: number
  agentName: string | null
  /** ``undefined`` when the trace has no turn span; ``null`` when unrecorded. */
  workspace: string | null | undefined
  providerModel: string | null
  sessionId: string | null
  inputTokens: number
  outputTokens: number
  cost: number
  failed: boolean
}

/**
 * Header facts for one trace, computed from its spans with the same rules
 * as the backend's trace list: the ``agent_run`` span names the turn, and
 * usage sums over every other span (LLM calls, summarization, titles).
 */
export function traceSummary(spans: SpanDetail[]): TraceSummary {
  const run = spans.find((s) => s.name.startsWith('agent_run'))
  let startMs = Infinity
  let endMs = -Infinity
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  for (const span of spans) {
    startMs = Math.min(startMs, span.start_ms)
    endMs = Math.max(endMs, span.end_ms)
    if (span === run) continue
    inputTokens += attrNumber(span.attributes, 'gen_ai.usage.input_tokens')
    outputTokens += attrNumber(span.attributes, 'gen_ai.usage.output_tokens')
    cost += attrNumber(span.attributes, 'gen_ai.usage.estimated_cost_usd')
  }
  const attrs = run?.attributes ?? {}
  const provider = attrString(attrs, 'gen_ai.provider.name')
  const model = attrString(attrs, 'gen_ai.request.model')
  const conversation = attrString(attrs, 'gen_ai.conversation.id')
  return {
    startMs: Number.isFinite(startMs) ? startMs : 0,
    durationMs: run ? run.duration_ms : Math.max(0, endMs - startMs),
    agentName: attrString(attrs, 'gen_ai.agent.name'),
    workspace: run ? attrString(attrs, WORKSPACE_ATTR) : undefined,
    providerModel: provider && model ? `${provider}:${model}` : model,
    sessionId: conversation && conversation !== NO_SESSION ? conversation : null,
    inputTokens,
    outputTokens,
    cost,
    failed: run ? run.status === 'ERROR' : spans.some((s) => s.status === 'ERROR'),
  }
}
