/**
 * Rich tool result renderers.
 *
 * Each renderer receives the raw `result` string emitted by the backend and
 * the `toolName` so it can pick the right display strategy. Fall back to the
 * generic text view when nothing more specific applies.
 *
 * Visual language matches the `ToolCall` aside: no opaque dark fills, no
 * boxed-in containers. Results flow under the same left-rule indentation
 * as the args. When a code-like block is needed (file contents, shell
 * output), we use a quiet `--bg-key` tint and a thin border
 * rather than an overlay. Theme-aware, no hard-coded rgba.
 */

import { ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { MarkdownBlock } from '@/utils/markdown'
import { truncateForDisplay } from '../ToolCall/displayText'
import { canonicalToolName } from '@/utils/tool-names'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import type { LiveSubagent } from '@/api/types'
import { SubagentRow, openSubagentSession, type SubagentRowProps } from '../ToolCall/SubagentRow'
import { parseStartedAt, subagentStatusView } from '../ToolCall/subagentStatus'
import { useSubagentRoster } from '../ToolCall/useSubagentRoster'
import { BackgroundProcessResult } from './BackgroundProcessResult'
import { FileListResult, FileReadResult } from './FileResults'
import { GenericResult, tryParseJSON } from './GenericResult'
import { LspDiagnosticsView, parseLspDiagnostics } from './LspDiagnostics'
import { LspNavigationResult } from './LspNavigationResult'
import { ScheduleTaskListResult } from './ScheduleTaskListResult'
import { ShellResult } from './ShellResult'
import { TodoListResult } from './TodoListResult'
import { WebSearchResult } from './WebSearchResult'

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/** A non-empty string field, or ``null``. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * What a subagent row shows for ``handle``: the live roster first (it knows
 * where the member is now: its session, its state, when it started), the
 * call's own snapshot behind it for a result read with no roster.
 */
function memberRow(
  handle: string,
  snapshot: Record<string, unknown> | null,
  roster: Map<string, LiveSubagent> | null,
): SubagentRowProps {
  const live = roster?.get(handle)
  return {
    handle,
    status: live?.status ?? str(snapshot?.status),
    sessionId: live?.session_id || str(snapshot?.session_id),
    startedAt: parseStartedAt(live?.created_at ?? snapshot?.created_at),
    hasPendingQuestion: live ? live.has_pending_question : snapshot?.has_pending_question === true,
  }
}

function TeamToolResult({ result }: { result: string }) {
  const parsed = tryParseJSON(result)
  if (!parsed || typeof parsed !== 'object') {
    return <GenericResult result={result} />
  }
  return <TeamResult obj={parsed as Record<string, unknown>} />
}

function TeamResult({ obj }: { obj: Record<string, unknown> }) {
  const status = typeof obj.status === 'string' ? obj.status : null
  const memberId = typeof obj.member_id === 'string' ? obj.member_id : null
  const output = typeof obj.output === 'string' ? obj.output : typeof obj.result === 'string' ? obj.result : null
  const message = typeof obj.message === 'string' ? obj.message : null
  const pendingQuestion = obj.pending_question && typeof obj.pending_question === 'object'
    ? (obj.pending_question as { question?: string; options?: string[] })
    : (typeof obj.question === 'string' ? { question: obj.question, options: Array.isArray(obj.options) ? (obj.options as string[]) : undefined } : null)
  const results = obj.results && typeof obj.results === 'object' ? (obj.results as Record<string, Record<string, unknown>>) : null
  const liveMembers = Array.isArray(obj.live_members)
    ? (obj.live_members as Record<string, unknown>[])
    : (Array.isArray(obj.subagents) ? (obj.subagents as Record<string, unknown>[]) : null)

  const roster = useSubagentRoster(Boolean(memberId || results || liveMembers))
  const header = memberId ? memberRow(memberId, obj, roster) : null
  const headerView = subagentStatusView(status)
  // Its question is open until the roster says the member moved on; with no
  // roster to say so, it is shown as asked.
  const live = memberId ? roster?.get(memberId) : undefined
  const stillAsking = !live || live.has_pending_question || live.status === 'waiting_lead'

  return (
    <div className="flex flex-col gap-2 font-mono text-xs leading-relaxed text-(--color-text-2)">
      {header ? (
        <SubagentRow {...header} status={header.status ?? status} />
      ) : (
        headerView && (
          <div className="flex flex-wrap items-center gap-1.5 font-sans">
            <Chip tone={headerView.tone} spinner={headerView.spinner} dot={headerView.waiting} data-team-status={status}>
              {headerView.label}
            </Chip>
          </div>
        )
      )}

      {pendingQuestion?.question && (
        <div className="rounded-sm border border-(--color-warning)/30 bg-(--color-warning-subtle)/50 p-2.5 font-sans text-xs text-(--color-text)">
          <div className="mb-1 font-medium text-(--accent-orange-text)">Question for the main agent</div>
          <div className="text-(--color-text) mb-1.5">{pendingQuestion.question}</div>
          {/* A subagent's session has no composer: the main agent answers, through
              its team tool. The choices are a plain list for the reader (nothing
              here to press), and the one control opens the subagent's session. */}
          {pendingQuestion.options && pendingQuestion.options.length > 0 && (
            <ul aria-label="Options" className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-(--color-text-2)">
              {pendingQuestion.options.map((opt, i) => (
                <li key={i}>{opt}</li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-xs text-(--color-text-muted)">The main agent answers subagent questions.</p>
          {header?.sessionId && stillAsking && (
            <Button
              type="button"
              variant="subtle"
              size="xs"
              className="mt-2"
              onClick={() => openSubagentSession(header.sessionId!)}
            >
              Open subagent session
              <ArrowUpRight size={12} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      {output && (
        <div className="max-h-[calc(16*1.55em)] overflow-y-auto rounded-xs bg-(--bg-card)/40 p-2 border border-(--color-border-subtle) text-xs">
          <MarkdownBlock content={truncateForDisplay(output)} />
        </div>
      )}

      {!output && message && (
        <div className="font-sans text-xs text-(--color-text-muted)">
          {message}
        </div>
      )}

      {results && (
        <div className="flex flex-col gap-2">
          {Object.entries(results).map(([handle, resObj]) => {
            const resStatus = typeof resObj.status === 'string' ? resObj.status : 'done'
            const resOutput = typeof resObj.output === 'string' ? resObj.output : typeof resObj.result === 'string' ? resObj.result : null
            const row = memberRow(handle, resObj, roster)
            return (
              <div key={handle} className="rounded-xs border border-(--color-border-subtle) bg-(--bg-card)/40 p-2 font-sans">
                <SubagentRow {...row} status={row.status ?? resStatus} className="mb-1.5" />
                {resOutput && (
                  // Phones: no scroller per member inside the transcript scroll.
                  <div data-team-member-output="" className="text-xs md:max-h-48 md:overflow-y-auto">
                    <MarkdownBlock content={truncateForDisplay(resOutput)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {liveMembers && liveMembers.length > 0 && (
        <div className="space-y-1 font-sans">
          <div className="label-caps text-(--color-text-muted)">Subagents</div>
          <div className="grid gap-0.5">
            {liveMembers.map((m, idx) => {
              const handle = String(m.member_id || m.profile)
              return <SubagentRow key={`${handle}:${idx}`} {...memberRow(handle, m, roster)} />
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ToolResultInner({ toolName: rawName, operation, result, headerAction, onCollapse }: { toolName: string; operation?: string; result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  const toolName = canonicalToolName(rawName)
  if (toolName === 'lsp') {
    return <LspNavigationResult operation={operation} result={result} />
  }
  if (toolName === 'web_search') {
    return <WebSearchResult result={result} />
  }
  if (toolName === 'bg') {
    return <BackgroundProcessResult result={result} headerAction={headerAction} onCollapse={onCollapse} />
  }
  if (toolName === 'schedule') {
    return <ScheduleTaskListResult result={result} />
  }
  if (toolName === 'shell') {
    return <ShellResult result={result} />
  }
  if (toolName === 'glob' || toolName === 'grep') {
    return <FileListResult result={result} />
  }
  if (toolName === 'read') {
    return <FileReadResult result={result} />
  }
  if (toolName === 'todo') {
    return <TodoListResult result={result} />
  }
  if (toolName === 'team') {
    return <TeamToolResult result={result} />
  }
  // web_fetch, date, math, skill, etc.
  return <GenericResult result={result} />
}

export function ToolResult({ toolName, operation, result, headerAction, onCollapse }: { toolName: string; operation?: string; result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  const lspData = parseLspDiagnostics(result)

  if (lspData) {
    return (
      <div className="flex flex-col gap-1">
        <ToolResultInner toolName={toolName} operation={operation} result={lspData.cleanText} headerAction={headerAction} onCollapse={onCollapse} />
        <LspDiagnosticsView diagnostics={lspData.diagnostics} overflowCount={lspData.overflowCount} />
      </div>
    )
  }

  return <ToolResultInner toolName={toolName} operation={operation} result={result} headerAction={headerAction} onCollapse={onCollapse} />
}
