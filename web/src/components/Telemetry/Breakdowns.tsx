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
import { ChevronRight } from 'lucide-react'
import type { ObservabilitySummary, SessionUsage } from '@/api/client'
import { Term, TERMS } from '@/components/ui/term'
import { SectionCard, SectionCardHeader, SectionCardRows } from '@/components/ui/section-card'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { cn } from '@/lib/utils'
import { formatCompact, formatMs, formatPercent, formatSpend, formatTps, timeAgo } from '@/utils/telemetryFormat'
import { nestSessions, sessionKey, sessionName, sharePct, workspaceName } from './model'
import { ModelId } from './ModelId'

/** The last two folders of a path, so the part that differs stays visible. */
function tailPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

type WorkspaceRow = NonNullable<ObservabilitySummary['by_workspace']>[number]
type ModelRow = ObservabilitySummary['by_model'][number]
type ToolRow = ObservabilitySummary['by_tool'][number]

const TOOL_PREVIEW = 8
const SESSION_PREVIEW = 8

interface Metric {
  value: string
  tone?: 'default' | 'muted' | 'error' | 'zero'
}

/** A numeric column: header text (or a Term), and its fixed width so every row lines up. */
interface Column {
  header: ReactNode
  /** Plain-text header for screen readers and the phone layout. */
  label: string
  width: string
}

/**
 * A breakdown as a small table: a header row, the name column first, then
 * right-aligned numeric columns with fixed widths, and a chevron when rows
 * filter the view. On phones the numbers drop under the name as labelled
 * pairs, so a long name keeps its room.
 */
function BreakdownTable({
  nameHeader,
  columns,
  filterable,
  children,
}: {
  nameHeader: string
  columns: Column[]
  /** Rows narrow the view on click: leaves room for the chevron. */
  filterable: boolean
  children: ReactNode
}) {
  const template = `minmax(0,1fr) ${columns.map((c) => c.width).join(' ')}${filterable ? ' 0.75rem' : ''}`
  return (
    <div style={{ '--breakdown-cols': template } as React.CSSProperties}>
      <div
        aria-hidden="true"
        className="hidden gap-x-3 border-b border-(--color-border)/60 px-3 py-1.5 text-[11px] font-medium text-(--color-text-muted) sm:grid sm:[grid-template-columns:var(--breakdown-cols)]"
      >
        <span>{nameHeader}</span>
        {columns.map((c) => <span key={c.label} className="text-right whitespace-nowrap">{c.header}</span>)}
        {filterable && <span />}
      </div>
      <SectionCardRows>{children}</SectionCardRows>
    </div>
  )
}

function BreakdownRow({
  label,
  detail,
  columns,
  metrics,
  share,
  shareTitle = 'Share of total spend',
  depth = 0,
  onSelect,
  selectHint,
  filterable,
  selected = false,
}: {
  label: ReactNode
  detail?: ReactNode
  columns: Column[]
  /** One per column, in column order. */
  metrics: Metric[]
  share: number
  /** What the share bar measures, for its tooltip. */
  shareTitle?: string
  /** Nesting level: a sub-agent session sits one step in from its parent. */
  depth?: number
  onSelect?: () => void
  /** Screen-reader suffix for clickable rows, e.g. "show only this workspace". */
  selectHint?: string
  /** The table has a chevron column (some rows filter). */
  filterable: boolean
  /** The view is narrowed to this row: highlighted, and not a shortcut. */
  selected?: boolean
}) {
  const body = (
    <>
      <span className="grid items-baseline gap-x-3 gap-y-1 sm:[grid-template-columns:var(--breakdown-cols)]">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="min-w-0 truncate text-xs text-(--color-text)">
            {label}
            {detail && <span className="ml-1.5 text-[11px] text-(--color-text-subtle)">{detail}</span>}
          </span>
          <span aria-hidden="true" title={`${shareTitle}: ${Math.round(share)}%`} className="block h-0.5 rounded-full bg-(--color-accent)/55" style={{ width: `${share}%` }} />
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums sm:contents">
          {metrics.map((m, i) => (
            <span
              key={columns[i]?.label ?? i}
              className={cn(
                'whitespace-nowrap sm:text-right',
                m.tone === 'error'
                  ? 'text-(--color-error)'
                  : m.tone === 'muted'
                    ? 'text-(--color-text-muted)'
                    : m.tone === 'zero'
                      ? 'text-(--color-text-subtle)'
                      : 'font-medium text-(--color-text)',
              )}
            >
              <span className="font-sans text-(--color-text-subtle) sm:sr-only">{columns[i]?.label} </span>
              {m.value}
            </span>
          ))}
        </span>
        {filterable && (
          <span aria-hidden="true" className="hidden text-(--color-text-subtle) sm:block">
            {onSelect ? <ChevronRight size={12} className="opacity-60 transition-opacity group-hover:opacity-100" /> : null}
          </span>
        )}
      </span>
      {onSelect && selectHint && <span className="sr-only">, {selectHint}</span>}
    </>
  )
  const className = cn('group flex w-full flex-col px-3 py-2 text-left', selected && 'bg-(--bg-key)')
  const style = depth > 0 ? { paddingLeft: `${0.75 + depth}rem` } : undefined
  if (!onSelect) return <div className={className} style={style} aria-current={selected ? 'true' : undefined}>{body}</div>
  return (
    <button
      type="button"
      onClick={onSelect}
      style={style}
      title={selectHint ? `Filter: ${selectHint}` : undefined}
      className={cn(
        className,
        'transition-colors duration-(--motion-instant) hover:bg-(--bg-page) focus-key:bg-(--bg-page) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
      )}
    >
      {body}
    </button>
  )
}

function Header({ title, aside }: { title: string; aside?: ReactNode }) {
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
      className="w-full border-t border-(--color-border) px-3 py-1.5 text-left text-[11px] text-(--color-text-muted) transition-colors hover:bg-(--bg-page) hover:text-(--color-text) pointer-coarse:min-h-11"
    >
      {expanded ? 'Show fewer' : `Show all ${total} ${noun}`}
    </button>
  )
}

const failedMetric = (n: number): Metric => (n > 0 ? { value: formatCompact(n), tone: 'error' } : { value: '0', tone: 'zero' })
const SPEND_HEADER = <Term definition={TERMS.spendEstimate}>Spend</Term>
const CACHE_HEADER = <Term definition={TERMS.cacheHit}>From cache</Term>
const SORTED = (byCost: boolean, noun: string) => (byCost ? 'Sorted by spend' : `Sorted by ${noun}`)

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
  const columns: Column[] = [
    { header: 'Turns', label: 'Turns', width: '2.75rem' },
    { header: 'Failed', label: 'Failed', width: '2.75rem' },
    { header: CACHE_HEADER, label: 'From cache', width: '4.5rem' },
    { header: SPEND_HEADER, label: 'Spend', width: '3.75rem' },
  ]
  return (
    <SectionCard>
      <Header title="Sessions" aside={`${SORTED(byCost, 'turns')} · click to filter`} />
      <BreakdownTable nameHeader="Session" columns={columns} filterable>
        {visible.map(({ row, depth }) => {
          const metrics: Metric[] = [
            { value: formatCompact(row.turns), tone: 'muted' },
            failedMetric(row.errors),
            { value: formatPercent(row.cache_percent), tone: 'muted' },
            { value: formatSpend(row.estimated_cost_usd) },
          ]
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
              shareTitle={byCost ? 'Share of total spend' : 'Share of all turns'}
              columns={columns}
              filterable
              depth={depth}
              selected={sessionKey(row.session_id) === selectedKey}
              onSelect={sessionKey(row.session_id) === selectedKey ? undefined : () => onSelect(row.session_id)}
              selectHint="show only this session"
            />
          )
        })}
      </BreakdownTable>
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
  const columns: Column[] = [
    { header: 'Turns', label: 'Turns', width: '2.75rem' },
    { header: 'Failed', label: 'Failed', width: '2.75rem' },
    { header: SPEND_HEADER, label: 'Spend', width: '3.75rem' },
  ]
  return (
    <SectionCard>
      <Header title="Workspaces" aside={`${SORTED(byCost, 'turns')} · click to filter`} />
      <BreakdownTable nameHeader="Workspace" columns={columns} filterable>
        {rows.map((row) => {
          const path = row.workspace
          const detail = path === null
            ? 'Turns from before workspaces were tracked, or from deleted sessions'
            : isChatWorkspacePath(path) ? undefined : <span className="font-mono" title={path}>{tailPath(path)}</span>
          const metrics: Metric[] = [
            { value: formatCompact(row.turns), tone: 'muted' },
            failedMetric(row.errors),
            { value: formatSpend(row.estimated_cost_usd) },
          ]
          return (
            <BreakdownRow
              key={path ?? '__unrecorded__'}
              label={<span className="font-medium">{path === null ? 'Unknown workspace' : workspaceName(path)}</span>}
              detail={detail}
              columns={columns}
              filterable
              metrics={metrics}
              share={byCost ? sharePct(row.estimated_cost_usd, totalSpend) : sharePct(row.turns, totalTurns)}
              shareTitle={byCost ? 'Share of total spend' : 'Share of all turns'}
              onSelect={path === null ? undefined : () => onSelect(path)}
              selectHint="show only this workspace"
            />
          )
        })}
      </BreakdownTable>
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
  const columns: Column[] = [
    { header: 'Calls', label: 'Calls', width: '2.75rem' },
    { header: <Term definition={TERMS.ttft}>TTFT p50</Term>, label: 'TTFT p50', width: '4rem' },
    { header: <Term definition={TERMS.tokPerSec}>tok/s</Term>, label: 'tok/s', width: '2.75rem' },
    { header: CACHE_HEADER, label: 'From cache', width: '4.5rem' },
    { header: SPEND_HEADER, label: 'Spend', width: '3.75rem' },
  ]
  const anyFilterable = rows.some((row) => filterable.has(row.provider_model))
  return (
    <SectionCard>
      <Header title="Models" aside={byCost ? 'Sorted by spend' : 'Sorted by calls'} />
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-(--color-text-muted)">No model calls in this range.</p>
      ) : (
        <BreakdownTable nameHeader="Model" columns={columns} filterable={anyFilterable}>
          {rows.map((row) => {
            // Speed only where it was measured (older spans lack it): "-".
            const ttft = row.ttft_p50_ms ?? 0
            const tps = row.output_tps_p50 ?? 0
            const metrics: Metric[] = [
              { value: formatCompact(row.calls), tone: 'muted' },
              { value: ttft > 0 ? formatMs(ttft) : '-', tone: ttft > 0 ? 'muted' : 'zero' },
              { value: tps > 0 ? formatTps(tps).replace(' tok/s', '') : '-', tone: tps > 0 ? 'muted' : 'zero' },
              { value: formatPercent(row.cache_percent), tone: 'muted' },
              { value: formatSpend(row.estimated_cost_usd) },
            ]
            return (
              <BreakdownRow
                key={row.provider_model}
                label={<ModelId id={row.provider_model} className="font-medium" />}
                columns={columns}
                filterable={anyFilterable}
                metrics={metrics}
                share={byCost ? sharePct(row.estimated_cost_usd, totalSpend) : sharePct(row.calls, totalCalls)}
                shareTitle={byCost ? 'Share of total spend' : 'Share of all calls'}
                onSelect={filterable.has(row.provider_model) ? () => onSelect(row.provider_model) : undefined}
                selectHint="show only turns on this model"
              />
            )
          })}
        </BreakdownTable>
      )}
    </SectionCard>
  )
}

export function ToolsCard({ rows }: { rows: ToolRow[] }) {
  const [expanded, setExpanded] = useState(false)
  const maxCalls = Math.max(0, ...rows.map((r) => r.calls))
  const visible = expanded ? rows : rows.slice(0, TOOL_PREVIEW)
  const columns: Column[] = [
    { header: 'Calls', label: 'Calls', width: '2.75rem' },
    { header: <Term definition={TERMS.p95}>p95</Term>, label: 'p95', width: '4rem' },
    { header: 'Errors', label: 'Errors', width: '3rem' },
  ]
  return (
    <SectionCard>
      <Header title="Tools" aside="Sorted by calls" />
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-(--color-text-muted)">No tool calls in this range.</p>
      ) : (
        <>
          <BreakdownTable nameHeader="Tool" columns={columns} filterable={false}>
            {visible.map((row) => {
              const metrics: Metric[] = [
                { value: formatCompact(row.calls) },
                { value: formatMs(row.p95_ms), tone: 'muted' },
                failedMetric(row.errors),
              ]
              return (
                <BreakdownRow
                  key={row.tool}
                  label={<span className="font-mono">{row.tool}</span>}
                  columns={columns}
                  filterable={false}
                  metrics={metrics}
                  share={sharePct(row.calls, maxCalls)}
                  shareTitle="Calls, relative to the busiest tool"
                />
              )
            })}
          </BreakdownTable>
          {rows.length > TOOL_PREVIEW && (
            <ShowAllButton expanded={expanded} total={rows.length} noun="tools" onToggle={() => setExpanded((v) => !v)} />
          )}
        </>
      )}
    </SectionCard>
  )
}
