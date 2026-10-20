/**
 * Where the spend went: per-workspace, per-session, per-model, and per-tool
 * breakdowns.
 *
 * Rows are ranked by the backend. Workspace, session, and model rows double
 * as filter shortcuts (click to narrow the whole overlay); tools are
 * informational.
 * Share bars have no track: the bar length is the comparison.
 */
import { useState, type ReactNode } from 'react'
import type { ObservabilitySummary, SessionUsage } from '@/api/client'
import { SectionCard, SectionCardHeader, SectionCardRows } from '@/components/ui/section-card'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { cn } from '@/lib/utils'
import { formatCompact, formatMs, formatPercent, formatSpend, formatTps, timeAgo } from '@/utils/telemetryFormat'
import { modelName, nestSessions, sessionKey, sessionName, sharePct, workspaceName } from './model'

type WorkspaceRow = NonNullable<ObservabilitySummary['by_workspace']>[number]
type ModelRow = ObservabilitySummary['by_model'][number]
type ToolRow = ObservabilitySummary['by_tool'][number]

const TOOL_PREVIEW = 8
const SESSION_PREVIEW = 8

interface Metric {
  value: string
  tone?: 'default' | 'muted' | 'error'
}

function BreakdownRow({
  label,
  detail,
  metrics,
  share,
  depth = 0,
  onSelect,
  selectHint,
}: {
  label: ReactNode
  detail?: ReactNode
  metrics: Metric[]
  share: number
  /** Nesting level: a sub-agent session sits one step in from its parent. */
  depth?: number
  onSelect?: () => void
  /** Screen-reader suffix for clickable rows, e.g. "show only this workspace". */
  selectHint?: string
}) {
  const body = (
    <>
      <span className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-(--color-text)">
          {label}
          {detail && <span className="ml-1.5 text-[11px] text-(--color-text-subtle)">{detail}</span>}
        </span>
        <span className="flex shrink-0 items-baseline gap-3 font-mono text-[11px] tabular-nums">
          {metrics.map((m, i) => (
            <span
              key={i}
              className={cn(
                'text-right',
                m.tone === 'error'
                  ? 'text-(--color-error)'
                  : m.tone === 'muted'
                    ? 'text-(--color-text-muted)'
                    : 'min-w-14 font-medium text-(--color-text)',
              )}
            >
              {m.value}
            </span>
          ))}
        </span>
      </span>
      <span aria-hidden="true" className="block h-0.5 rounded-full bg-(--color-accent)/55" style={{ width: `${share}%` }} />
      {onSelect && selectHint && <span className="sr-only">, {selectHint}</span>}
    </>
  )
  const className = 'flex w-full flex-col gap-1.5 px-3 py-2 text-left'
  const style = depth > 0 ? { paddingLeft: `${0.75 + depth}rem` } : undefined
  if (!onSelect) return <div className={className} style={style}>{body}</div>
  return (
    <button
      type="button"
      onClick={onSelect}
      style={style}
      className={cn(
        className,
        'transition-colors duration-(--motion-instant) hover:bg-(--bg-page) focus-visible:bg-(--bg-page) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)/40',
      )}
    >
      {body}
    </button>
  )
}

function Header({ title, aside }: { title: string; aside?: string }) {
  return (
    <SectionCardHeader className="flex items-center justify-between gap-2">
      <span>{title}</span>
      {aside && <span className="font-normal normal-case tracking-normal text-(--color-text-subtle)">{aside}</span>}
    </SectionCardHeader>
  )
}

function ShowAllButton({ expanded, total, noun, onToggle }: { expanded: boolean; total: number; noun: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full border-t border-(--color-border) px-3 py-1.5 text-left text-[11px] text-(--color-text-muted) transition-colors hover:bg-(--bg-page) hover:text-(--color-text)"
    >
      {expanded ? 'Show fewer' : `Show all ${total} ${noun}`}
    </button>
  )
}

export function SessionsCard({
  rows,
  showWorkspace,
  selected = null,
  onSelect,
}: {
  rows: SessionUsage[]
  /** Off while a workspace filter makes it the same on every row. */
  showWorkspace: boolean
  /** The session the view is narrowed to; its own row is not a shortcut. */
  selected?: string | null
  onSelect: (sessionId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  // Relative times are computed once per mount, like the turns table.
  const [now] = useState(() => Date.now())
  const totalSpend = rows.reduce((sum, r) => sum + r.estimated_cost_usd, 0)
  const totalTurns = rows.reduce((sum, r) => sum + r.turns, 0)
  const byCost = totalSpend > 0
  const nested = nestSessions(rows)
  const visible = expanded ? nested : nested.slice(0, SESSION_PREVIEW)
  const selectedKey = selected === null ? null : sessionKey(selected)
  return (
    <SectionCard>
      <Header title="Sessions" aside={byCost ? 'By spend' : 'By turns'} />
      <SectionCardRows>
        {visible.map(({ row, depth }) => {
          const metrics: Metric[] = []
          if (row.errors > 0) metrics.push({ value: `${formatCompact(row.errors)} failed`, tone: 'error' })
          metrics.push({ value: `${formatPercent(row.cache_percent)} cached`, tone: 'muted' })
          metrics.push({ value: `${formatCompact(row.turns)} ${row.turns === 1 ? 'turn' : 'turns'}`, tone: 'muted' })
          metrics.push({ value: formatSpend(row.estimated_cost_usd) })
          const where = showWorkspace && row.workspace !== null ? `${workspaceName(row.workspace)}, ` : ''
          return (
            <BreakdownRow
              key={row.session_id}
              label={
                <span className={cn('font-medium', row.deleted && 'text-(--color-text-muted)')}>{sessionName(row)}</span>
              }
              detail={`${where}${timeAgo(row.last_active_ms, now)}`}
              metrics={metrics}
              share={byCost ? sharePct(row.estimated_cost_usd, totalSpend) : sharePct(row.turns, totalTurns)}
              depth={depth}
              onSelect={sessionKey(row.session_id) === selectedKey ? undefined : () => onSelect(row.session_id)}
              selectHint="show only this session"
            />
          )
        })}
      </SectionCardRows>
      {rows.length > SESSION_PREVIEW && (
        <ShowAllButton expanded={expanded} total={rows.length} noun="sessions" onToggle={() => setExpanded((v) => !v)} />
      )}
    </SectionCard>
  )
}

export function WorkspacesCard({
  rows,
  onSelect,
}: {
  rows: WorkspaceRow[]
  onSelect: (workspace: string) => void
}) {
  const totalSpend = rows.reduce((sum, r) => sum + r.estimated_cost_usd, 0)
  const totalTurns = rows.reduce((sum, r) => sum + r.turns, 0)
  const byCost = totalSpend > 0
  return (
    <SectionCard>
      <Header title="Workspaces" aside={byCost ? 'By spend' : 'By turns'} />
      <SectionCardRows>
        {rows.map((row) => {
          const path = row.workspace
          const detail = path === null
            ? 'Workspace unknown: older telemetry from a deleted session, or work outside a session'
            : isChatWorkspacePath(path) ? undefined : path
          const metrics: Metric[] = []
          if (row.errors > 0) metrics.push({ value: `${formatCompact(row.errors)} failed`, tone: 'error' })
          metrics.push({ value: `${formatCompact(row.turns)} ${row.turns === 1 ? 'turn' : 'turns'}`, tone: 'muted' })
          metrics.push({ value: formatSpend(row.estimated_cost_usd) })
          return (
            <BreakdownRow
              key={path ?? '__unrecorded__'}
              label={<span className="font-medium">{workspaceName(path)}</span>}
              detail={detail}
              metrics={metrics}
              share={byCost ? sharePct(row.estimated_cost_usd, totalSpend) : sharePct(row.turns, totalTurns)}
              onSelect={path === null ? undefined : () => onSelect(path)}
              selectHint="show only this workspace"
            />
          )
        })}
      </SectionCardRows>
    </SectionCard>
  )
}

export function ModelsCard({
  rows,
  filterable,
  onSelect,
}: {
  rows: ModelRow[]
  /** ``provider:model`` values the backend can filter by (turn models). */
  filterable: ReadonlySet<string>
  onSelect: (providerModel: string) => void
}) {
  const totalSpend = rows.reduce((sum, r) => sum + r.estimated_cost_usd, 0)
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0)
  const byCost = totalSpend > 0
  return (
    <SectionCard>
      <Header title="Models" aside={byCost ? 'By spend' : 'By calls'} />
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-(--color-text-muted)">No model calls in this range.</p>
      ) : (
        <SectionCardRows>
          {rows.map((row) => {
            // Speed only where it was measured (older spans lack it).
            const metrics: Metric[] = []
            if ((row.ttft_p50_ms ?? 0) > 0) metrics.push({ value: `TTFT ${formatMs(row.ttft_p50_ms ?? 0)}`, tone: 'muted' })
            if ((row.output_tps_p50 ?? 0) > 0) metrics.push({ value: formatTps(row.output_tps_p50 ?? 0), tone: 'muted' })
            metrics.push({ value: `${formatPercent(row.cache_percent)} cached`, tone: 'muted' })
            metrics.push({ value: `${formatCompact(row.calls)} ${row.calls === 1 ? 'call' : 'calls'}`, tone: 'muted' })
            metrics.push({ value: formatSpend(row.estimated_cost_usd) })
            return (
              <BreakdownRow
                key={row.provider_model}
                label={<span className="font-mono font-medium">{modelName(row.provider_model)}</span>}
                detail={row.provider}
                metrics={metrics}
                share={byCost ? sharePct(row.estimated_cost_usd, totalSpend) : sharePct(row.calls, totalCalls)}
                onSelect={filterable.has(row.provider_model) ? () => onSelect(row.provider_model) : undefined}
                selectHint="show only turns on this model"
              />
            )
          })}
        </SectionCardRows>
      )}
    </SectionCard>
  )
}

export function ToolsCard({ rows }: { rows: ToolRow[] }) {
  const [expanded, setExpanded] = useState(false)
  const maxCalls = Math.max(0, ...rows.map((r) => r.calls))
  const visible = expanded ? rows : rows.slice(0, TOOL_PREVIEW)
  return (
    <SectionCard>
      <Header title="Tools" aside="By calls" />
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-(--color-text-muted)">No tool calls in this range.</p>
      ) : (
        <>
          <SectionCardRows>
            {visible.map((row) => {
              const metrics: Metric[] = []
              if (row.errors > 0) metrics.push({ value: `${formatCompact(row.errors)} failed`, tone: 'error' })
              metrics.push({ value: `p95 ${formatMs(row.p95_ms)}`, tone: 'muted' })
              metrics.push({ value: formatCompact(row.calls) })
              return (
                <BreakdownRow
                  key={row.tool}
                  label={<span className="font-mono">{row.tool}</span>}
                  metrics={metrics}
                  share={sharePct(row.calls, maxCalls)}
                />
              )
            })}
          </SectionCardRows>
          {rows.length > TOOL_PREVIEW && (
            <ShowAllButton expanded={expanded} total={rows.length} noun="tools" onToggle={() => setExpanded((v) => !v)} />
          )}
        </>
      )}
    </SectionCard>
  )
}
