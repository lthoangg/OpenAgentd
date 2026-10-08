/**
 * Body of the telemetry overlay: the overview, or one turn's
 * trace when ``traceId`` is set. All view state lives in useTelemetryStore
 * so deep links and the palette can open any of it.
 *
 * Overview order follows the questions a user asks: how much and how often
 * (stats, activity), where (workspaces, sessions), with what (models,
 * tools), and what just happened (recent turns). A session filter turns the
 * same cards into a per-session view under a session heading; the backend
 * counts the session's sub-agent sessions in it, listed in the Sessions card.
 */
import { useMemo, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { useInfiniteTracesQuery, useObservabilitySummaryQuery } from '@/queries'
import { cn } from '@/lib/utils'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { formatShortId } from '@/utils/telemetryFormat'
import { ActivityChart } from './ActivityChart'
import { ModelsCard, SessionsCard, ToolsCard, WorkspacesCard } from './Breakdowns'
import { FilterBar } from './FilterBar'
import { dailySeries, headline, sessionKey, sessionName } from './model'
import { OverviewStats } from './OverviewStats'
import { RecentTurns } from './RecentTurns'
import { SessionHeader } from './SessionHeader'
import { TelemetrySkeleton } from './TelemetrySkeleton'
import { TraceView } from './TraceView'

const TURNS_PAGE_SIZE = 25

const SECONDARY_BUTTON_CLASS =
  'h-7 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 text-xs text-(--color-text) transition-colors hover:bg-(--bg-key) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40'

export interface TelemetryViewProps {
  /** Navigate to a session (the overlay closes itself around this). */
  onOpenSession?: (sessionId: string) => void
}

export function TelemetryView({ onOpenSession }: TelemetryViewProps) {
  const traceId = useTelemetryStore((s) => s.traceId)
  const days = useTelemetryStore((s) => s.days)
  if (traceId) return <TraceView key={traceId} traceId={traceId} days={days} onOpenSession={onOpenSession} />
  return <OverviewPane onOpenSession={onOpenSession} />
}

function CenteredMessage({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-(--color-text)">{title}</p>
      {body && <p className="max-w-sm text-xs text-(--color-text-muted)">{body}</p>}
      {action}
    </div>
  )
}

function OverviewPane({ onOpenSession }: TelemetryViewProps) {
  const days = useTelemetryStore((s) => s.days)
  const workspace = useTelemetryStore((s) => s.workspace)
  const model = useTelemetryStore((s) => s.model)
  const session = useTelemetryStore((s) => s.session)
  const errorsOnly = useTelemetryStore((s) => s.errorsOnly)
  const setDays = useTelemetryStore((s) => s.setDays)
  const setWorkspace = useTelemetryStore((s) => s.setWorkspace)
  const setModel = useTelemetryStore((s) => s.setModel)
  const setSession = useTelemetryStore((s) => s.setSession)
  const setErrorsOnly = useTelemetryStore((s) => s.setErrorsOnly)
  const openTrace = useTelemetryStore((s) => s.openTrace)
  const clearFilters = useTelemetryStore((s) => s.clearFilters)

  const summary = useObservabilitySummaryQuery(days, { workspace, model, session })
  const turns = useInfiniteTracesQuery(days, TURNS_PAGE_SIZE, { workspace, model, session, errorsOnly })
  const data = summary.data
  const facets = data?.facets ?? null
  const filterableModels = useMemo(() => new Set(facets?.models ?? []), [facets])
  const turnRows = useMemo(() => turns.data?.pages.flatMap((page) => page.traces) ?? [], [turns.data])
  const showAgent = useMemo(() => new Set(turnRows.map((turn) => turn.agent_name ?? '')).size > 1, [turnRows])
  const turnTotal = turns.data?.pages[0]?.total ?? turnRows.length
  const filtered = workspace !== null || model !== null || session !== null
  const sessionRow = session ? (data?.by_session?.find((row) => row.session_id === session) ?? null) : null
  const sessionLabel = session === null ? null : sessionRow ? sessionName(sessionRow) : data ? formatShortId(session) : null

  let body: ReactNode
  if (!data) {
    body = summary.isError ? (
      <CenteredMessage
        title="Could not load telemetry"
        body="The server did not return usage data."
        action={
          <button type="button" onClick={() => void summary.refetch()} className={SECONDARY_BUTTON_CLASS}>
            Retry
          </button>
        }
      />
    ) : (
      <TelemetrySkeleton withFilterBar={false} />
    )
  } else if (data.totals.turns === 0 && data.totals.llm_calls === 0 && data.totals.tool_calls === 0) {
    body = filtered ? (
      <CenteredMessage
        title="No turns match these filters"
        body="Try a longer range or clear the filters."
        action={
          <button type="button" onClick={clearFilters} className={SECONDARY_BUTTON_CLASS}>
            Clear filters
          </button>
        }
      />
    ) : (
      <CenteredMessage title="No telemetry yet" body="Spend, turns, and traces appear here after an agent runs." />
    )
  } else {
    const workspaces = data.by_workspace ?? []
    const sessions = data.by_session ?? []
    const showWorkspaces = workspace === null && session === null && workspaces.length > 1
    // Under a session filter the rows are the session and its sub-agents.
    const showSessions = sessions.length > 1
    const subAgentCount = session === null ? 0 : sessions.filter((row) => sessionKey(row.session_id) !== sessionKey(session)).length
    body = (
      <div className="flex flex-col gap-4 p-3 sm:p-4">
        {session !== null && (
          <SessionHeader sessionId={session} row={sessionRow} subAgentCount={subAgentCount} onOpenSession={onOpenSession} />
        )}
        {data.sample_ratio < 1 && (
          <p className="flex items-start gap-2 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-xs text-(--color-text-2)">
            <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-(--color-accent)" />
            <span>
              Spans are sampled at {Math.round(data.sample_ratio * 100)}%, so totals are approximate. Set{' '}
              <code className="rounded-xs bg-(--bg-key) px-1 font-mono text-[11px]">OTEL_SPAN_SAMPLE_RATIO=1.0</code> to record
              every span.
            </span>
          </p>
        )}
        <OverviewStats data={headline(data)} />
        {days > 1 && (
          <ActivityChart points={dailySeries(data)} hasCost={data.daily_turns.some((d) => d.estimated_cost_usd !== undefined)} />
        )}
        {(showWorkspaces || showSessions) && (
          <div className={cn('grid items-start gap-4', showWorkspaces && showSessions && 'lg:grid-cols-2')}>
            {showWorkspaces && <WorkspacesCard rows={workspaces} onSelect={setWorkspace} />}
            {showSessions && (
              <SessionsCard rows={sessions} showWorkspace={workspace === null && session === null} selected={session} onSelect={setSession} />
            )}
          </div>
        )}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <ModelsCard rows={data.by_model} filterable={filterableModels} onSelect={setModel} />
          <ToolsCard rows={data.by_tool} />
        </div>
        <RecentTurns
          turns={turnRows}
          total={turnTotal}
          status={turns.status}
          hasMore={turns.hasNextPage}
          loadingMore={turns.isFetchingNextPage}
          onLoadMore={() => {
            if (turns.hasNextPage && !turns.isFetchingNextPage) void turns.fetchNextPage()
          }}
          onRetry={() => void turns.refetch()}
          onOpen={openTrace}
          errorsOnly={errorsOnly}
          onErrorsOnlyChange={setErrorsOnly}
          showWorkspace={workspace === null && session === null && workspaces.length > 1}
          showModel={model === null}
          showAgent={showAgent}
        />
      </div>
    )
  }

  return (
    <>
      <FilterBar
        days={days}
        onDaysChange={setDays}
        workspace={workspace}
        onWorkspaceChange={setWorkspace}
        model={model}
        onModelChange={setModel}
        session={session}
        sessionLabel={sessionLabel}
        onSessionChange={setSession}
        facets={facets}
        onClear={clearFilters}
        fetching={summary.isFetching || (turns.isFetching && !turns.isFetchingNextPage)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </>
  )
}
