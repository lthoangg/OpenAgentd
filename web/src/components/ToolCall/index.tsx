/**
 * ToolCall — inline record of a tool invocation.
 *
 * Visual language follows the pencil source (nodes ``dqwZw`` / ``LJOUY``)
 * and the canonical spec at ``applications.md#tool-call-row``:
 *
 *   - Collapsed row: no card fill; sits on the ambient chat surface.
 *   - Header row: mono tool label + optional summary + chevron.
 *   - Expanded body: separate bordered inspector with section panels so
 *     args/results read as secondary diagnostic content.
 *
 * Running state is carried by subtle header animation. The row makes no
 * success/failure claim and shows no result summary: most tools' output
 * stays on the server (``resultBytes``) and is fetched when the row opens.
 * The row opens only when the user opens it, live output included: a
 * streaming tool never unfolds (or folds) the transcript by itself.
 *
 * The per-tool header/args customisation lives in ``./display.tsx``;
 * this module owns only the chrome (collapse, copy, motion).
 */

import { useEffect, useId, useRef, useState, useMemo, useCallback, memo } from 'react'
import { ArrowUpRight, ChevronRight, FileText, GitBranch, Globe } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { previewsAvailable } from '@/api/preview'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { ToolResult } from '../ToolResult'
import { copyText, type ChatMenuItem } from '../ChatContextMenu'
import { AskUser, useShowsConfirmationCard } from '../AskUser'
import { PlanReviewCard } from '../PlanReview/PlanReviewCard'
import { PREVIEW_TOOL, isPreviewOpenSuccess, previewTargetFromArgs, requestOpenPreview } from '../Preview/preview-events'
import { parseSendResult, requestOpenSession } from '@/utils/workspace-messages'
import { tokenizeCode } from '@/utils/code-highlight'
import { PINNED_HEADER, useCloseInPlace } from '@/hooks/useStickyFold'
import { cn } from '@/lib/utils'
import { Collapsible } from '@/components/ui/collapsible'
import { getToolDisplay } from './display'
import { DiffView } from './DiffView'
import { ReadView } from './ReadView'
import { ImageViewChip } from './ImageViewChip'
import { parseImageRead } from './imageRead'
import { TOOL_CHIP_CLASS } from './chipStyles'
import { CopyButton } from './CopyButton'
import { SectionHeader } from './SectionHeader'
import { ToolRow } from './ToolRow'
import { subscribeLiveClock } from './liveClock'
import { RosterSubagentRow } from './SubagentRow'
import { teamMemberFromResult } from './subagentStatus'
import { getDiffStats } from './diffUtils'
import { isFailedResult } from './toolResultStatus'
import { parseShellOutcome } from './summary'
import { fetchToolArguments, fetchToolResult, useToolArguments, useToolResult } from './useToolResult'
import { formatMetaDuration } from '@/components/ui/meta-row'
import type { ToolCallState } from './types'
import { canonicalToolName, isPlanSubmission, opensConfirmation } from '@/utils/tool-names'
import { GoalClaimCard } from '../GoalClaimCard'
import { UPDATE_GOAL_TOOL } from '@/lib/goal'

/** Matches ``app.agent.agent_loop.core.ASK_USER``. */
const ASK_USER = 'ask_user'
/** Matches ``appv3_agent::tools::plan::PLAN_TOOL``. */
const PLAN_TOOL = 'plan'
const WORKSPACE_TOOL = 'workspace'
const TEAM_TOOL = 'team'

interface ToolCallProps {
  name: string
  args?: string
  done?: boolean
  liveOutput?: string
  result?: string // tool response content
  /** Bytes of output that stayed on the server; fetched when the row opens. */
  resultBytes?: number
  /**
   * Set when ``args`` is the short form history sends (a shell call without
   * its command, a patch's files, a plan without its Markdown): the full
   * arguments' size. They are fetched when the row opens.
   */
  argsBytes?: number
  durationMs?: number
  startedAt?: number
  /** Needed by ``ask_user`` to match the call against the open question. */
  toolCallId?: string
}


function tryParseJSON(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseJsonStrings(val: unknown): unknown {
  if (typeof val === 'string') {
    const trimmed = val.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      const parsed = tryParseJSON(trimmed)
      if (parsed !== null && typeof parsed === 'object') {
        return parseJsonStrings(parsed)
      }
    }
    return val
  }
  if (Array.isArray(val)) {
    return val.map(parseJsonStrings)
  }
  if (val !== null && typeof val === 'object') {
    const res: Record<string, unknown> = {}
    for (const key of Object.keys(val)) {
      res[key] = parseJsonStrings((val as Record<string, unknown>)[key])
    }
    return res
  }
  return val
}

/** The args as the details view shows them: JSON-encoded strings unwrapped, pretty-printed. */
function formatArgsDetails(formattedArgs: string | null | undefined): string {
  if (!formattedArgs) return ''
  const parsed = tryParseJSON(formattedArgs)
  if (parsed !== null && typeof parsed === 'object') {
    return JSON.stringify(parseJsonStrings(parsed), null, 2)
  }
  return formattedArgs
}

const MAX_LIVE_LINES = 100

// The shared live clock moved to ./liveClock (ToolResult uses it too); the
// reader's work row still imports it from here.
export { subscribeLiveClock }

function clampLiveOutput(output: string | undefined): string | undefined {
  if (!output) return undefined
  if (output.length < 50_000) return output
  const lines = output.split('\n')
  if (lines.length <= MAX_LIVE_LINES) return output
  return `… [${lines.length - MAX_LIVE_LINES} earlier lines hidden while streaming]\n` + lines.slice(-MAX_LIVE_LINES).join('\n')
}

/**
 * Syntax-highlights a shell command string.
 *
 * Rendered inline inside the `<pre>` terminal block — sits right after the
 * `$ ` prompt. Commands are short, so tokens are rendered as React elements
 * rather than injected HTML — the text is escaped by React, and the element
 * count stays trivial.
 */
const ShellCommand = memo(function ShellCommand({ command }: { command: string }) {
  const highlighted = useMemo(
    () =>
      tokenizeCode(command, 'shell').map((token, index) =>
        token.className ? (
          <span key={index} className={`th-token th-${token.className}`}>
            {token.value}
          </span>
        ) : (
          token.value
        ),
      ),
    [command],
  )

  return <code>{highlighted}</code>
})

export const ToolCall = memo(function ToolCall({ name, args, done, liveOutput, result: inlineResult, resultBytes, argsBytes, durationMs, startedAt, toolCallId }: ToolCallProps) {
  // Hooks must be called unconditionally — before any early returns
  // Closed until the user opens it; nothing opens the row on its own.
  const [expanded, setManualExpanded] = useState(false)
  // The open details region: the row's toggle and every section header point at it.
  const detailsId = useId()
  const liveOutputRef = useRef<HTMLPreElement>(null)
  const isAttachedRef = useRef(true)
  const [now, setNow] = useState(() => Date.now())
  // The enter animation marks a tool that just joined a live transcript, so
  // it is decided once, at mount: a row that mounts finished is history (a
  // reopen, a revealed turn, an older page, a reconnect replay), and
  // animating those started hundreds of compositor animations at once.
  const [animatesIn] = useState(() => !done)
  // The output stayed on the server: the row fetches it once opened.
  const onServer = Boolean(done) && inlineResult === undefined && resultBytes !== undefined && Boolean(toolCallId)
  // The fetch waits for the user to open the row.
  const [fetchWanted, setFetchWanted] = useState(false)
  const remote = useToolResult(toolCallId, onServer, fetchWanted)
  const result = inlineResult ?? remote.text
  // Short arguments: the row reads them; the open details need the full ones.
  const argsOnServer = argsBytes !== undefined && Boolean(toolCallId)
  const remoteArgs = useToolArguments(toolCallId, argsOnServer, fetchWanted)
  const fullArgs = argsOnServer ? remoteArgs.text : args
  const awaitingArgs = argsOnServer && fullArgs === undefined
  // A change to OpenAgentd's setup waits on the user's Apply / Cancel.
  const confirmationCard = useShowsConfirmationCard(opensConfirmation(name, args ?? undefined), toolCallId, result)

  // Status: start (name only) → running (args) → done. No success/failure:
  // the agent reads its tools' output and acts on a failure itself.
  const isPending = args === undefined || args === null
  const isRunning = !isPending && !done
  const state: ToolCallState = isPending ? 'start' : isRunning ? 'running' : 'success'

  // Me: getToolDisplay/getDiffStats are pure functions of (name, args,
  // result) — memoize them so ToolCall's own 1s elapsed-timer tick
  // (`now`, below) doesn't re-run a full JSON.parse and, for edit/patch/
  // write, an O(oldLines*newLines) diff on every tick for the entire
  // lifetime of a running tool call just to redraw the duration label.
  const { header, headerTitle, fullTarget, language, suppressResult } =
    useMemo(() => getToolDisplay(name, args), [name, args])
  // The details show the full arguments, once here.
  const { formattedArgs } = useMemo(
    () => (fullArgs === undefined ? { formattedArgs: null } : getToolDisplay(name, fullArgs)),
    [name, fullArgs],
  )
  const toolOperation = useMemo(() => {
    if (name !== 'lsp' || !args) return undefined
    const parsed = tryParseJSON(args)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const operation = (parsed as Record<string, unknown>).operation
    return typeof operation === 'string' ? operation : undefined
  }, [name, args])
  const usesDiffView = name === 'patch'
  const usesReadView = name === 'read'
  const diffStats = useMemo(
    () => usesDiffView && args && !isFailedResult(result) ? getDiffStats(name, args, result) : null,
    [usesDiffView, name, args, result],
  )
  const previewTarget = useMemo(
    () => (name === PREVIEW_TOOL && done && isPreviewOpenSuccess(result) && previewsAvailable() ? previewTargetFromArgs(args) : null),
    [name, done, result, args],
  )
  // The session a workspace message reached, so the user can switch to it.
  const sentSession = useMemo(
    () => (canonicalToolName(name) === WORKSPACE_TOOL && done ? parseSendResult(result) : null),
    [name, done, result],
  )
  // A saved plan opens in the Plan tab.
  const planLink = name === PLAN_TOOL && done && !isFailedResult(result) ? 'Open plan' : null
  // The subagent a team call started or messaged: its row sits under the
  // call, so following it takes one click, not an expand and then a click.
  const teamMember = useMemo(
    () => (canonicalToolName(name) === TEAM_TOOL && done ? teamMemberFromResult(result) : null),
    [name, done, result],
  )
  // An image the agent read opens in the dock.
  const imageRead = useMemo(() => (name === 'read' && done ? parseImageRead(result) : null), [name, done, result])
  // Pending-state header comes from getToolDisplay's no-args branch
  // (e.g. ``recall`` → "Checking memory…"). Tools without a custom pending header return
  // ``header: null`` from that branch and fall back to the raw tool name
  // below, preserving the previous behaviour for every other tool.
  const visibleHeader = header
  const shownResult = suppressResult ? undefined : result
  const rawLiveOutput = (suppressResult || shownResult) ? undefined : liveOutput
  const shownLiveOutput = done ? rawLiveOutput : clampLiveOutput(rawLiveOutput)
  const hasReadResult = usesReadView
  const isBackgroundProcess = name === 'bg'
  const isScheduleTaskList = canonicalToolName(name) === 'schedule' && shownResult?.startsWith('Scheduled tasks (')
  const isShell = language === 'bash'
  const isShellTerminal = isShell && Boolean(formattedArgs)
  // The `[Succeeded]` / `[Failed — exit code 1]` status line is protocol, not
  // output: the row's exit chip carries it.
  const shellParsed = isShell ? parseShellOutcome(shownResult) : null
  const shellBody = shellParsed ? shellParsed.body || null : isShell ? shownResult || null : null
  const shellOutput = shellBody ?? shownLiveOutput

  useEffect(() => {
    if (done || !startedAt) return
    return subscribeLiveClock((currentTime) => {
      setNow(currentTime)
    })
  }, [done, startedAt])

  const handleScroll = useCallback((e: React.UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isAttachedRef.current = distFromBottom <= 30
  }, [])

  useEffect(() => {
    const el = liveOutputRef.current
    if (el && isAttachedRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [shownLiveOutput, shellOutput])

  // What the arguments' Copy control takes: a terminal block is the command
  // with its output; any other section is the args as the details show them.
  const argsCopyText = () =>
    isShellTerminal
      ? `${formattedArgs}${shellOutput ? `\n${shellOutput}` : ''}`
      : formatArgsDetails(formattedArgs) || args || ''
  const argsCopyLabel = isShellTerminal ? (shellOutput ? 'Copy command and output' : 'Copy command') : 'Copy arguments'

  const resultCopyButton = <CopyButton label="Copy result" text={result || ''} />

  const awaitingResult = onServer && !suppressResult && result === undefined
  // A target the header cut (a long URL, query or pattern) shows whole in the
  // open row, as its arguments, when the tool has no other arguments to show.
  const targetArg = formattedArgs ? null : fullTarget ?? null
  const argsShown = Boolean(formattedArgs || targetArg)
  const hasDetails = Boolean(argsShown || shownLiveOutput || shownResult || hasReadResult || awaitingResult || awaitingArgs)
  // Open, the header pins while long details scroll under it (inside a reader
  // fold, just below the fold's row); closing leaves it where it was pressed.
  const pinned = expanded && hasDetails
  const { anchorRef: headerRef, markClose } = useCloseInPlace(pinned)
  const collapse = (control: HTMLElement) => {
    markClose(control)
    setManualExpanded(false)
  }
  const open = () => {
    setFetchWanted(true)
    setManualExpanded(true)
  }
  // Only an open row shows these, and reopening a long run mounts hundreds of
  // collapsed rows at once: the parse + pretty-print waits for the expand.
  const displayedArgs = useMemo(() => (expanded ? formatArgsDetails(formattedArgs) : ''), [expanded, formattedArgs])
  const displayName = name || 'tool'
  // The whole label, for tools and tests that read it. The row has no
  // tooltip: what it cuts, the open row shows (``ToolDisplay.fullTarget``).
  const label = headerTitle ? `${displayName}: ${headerTitle}` : displayName
  const elapsedMs = durationMs ?? (!done && startedAt ? now - startedAt : undefined)

  // The row's right-click menu and touch long-press sheet. Like the Copy
  // controls in the details, it copies what the details show: a tool that hides
  // its args (a search, a glob) has none to copy, and one that hides its result
  // (a generated image) has none either. A result only exists once the tool is done.
  const menuItems = (): ChatMenuItem[] => {
    const argsText = isShellTerminal ? formattedArgs : formatArgsDetails(formattedArgs)
    const resultText = done && (shownResult || hasReadResult) ? result : undefined
    const fetchable = awaitingResult && toolCallId
    const argsFetchable = awaitingArgs && toolCallId
    // What the details' args section would show, from arguments fetched now.
    const copyFetchedArgs = (text: string) => {
      const shown = getToolDisplay(name, text).formattedArgs
      copyText(isShell ? shown ?? '' : formatArgsDetails(shown) || text)
    }
    return [
      ...(argsText ? [{ label: 'Copy arguments', run: () => copyText(argsText) }] : []),
      ...(!argsText && argsFetchable ? [{ label: 'Copy arguments', run: () => { void fetchToolArguments(argsFetchable).then(copyFetchedArgs) } }] : []),
      ...(resultText ? [{ label: 'Copy result', run: () => copyText(resultText) }] : []),
      ...(!resultText && fetchable ? [{ label: 'Copy result', run: () => { void fetchToolResult(fetchable).then(copyText) } }] : []),
    ]
  }

  // ``ask_user`` owns its whole card — frame and label included, since
  // both track whether the question is still open. An unanswered question must
  // not be hidden behind a disclosure triangle, and once answered it is a
  // two-line summary with nothing to collapse. It also must not show the
  // persisted "waiting for the user" placeholder as a finished tool result.
  if (name === ASK_USER || confirmationCard) {
    return <AskUser toolCallId={toolCallId} args={args} result={result} />
  }
  // A plan submission is reviewed in the Plan tab; its card records the outcome.
  if (isPlanSubmission(name, args)) {
    return <PlanReviewCard toolCallId={toolCallId} args={args} result={result} done={done} />
  }
  // ``update_goal`` reads as the claim's outcome: achieved, not yet, or blocked.
  if (name === UPDATE_GOAL_TOOL) {
    return <GoalClaimCard args={args} result={result} done={done} animatesIn={animatesIn} />
  }

  return (
    <div className={animatesIn ? 'tool-row-enter my-0.5' : 'my-0.5'}>
      {/* The row: real tool name, target, result summary, and a right-aligned
          meta column (exit code, duration). A row with nothing to open is a
          plain div, so it adds no empty Tab stop. */}
      <div className={cn(pinned && cn(PINNED_HEADER, 'bg-(--bg-page)'))}>
        <ToolRow
          // The row is a div until it has details, then a button: a new element
          // remounts it, so the menu re-registers its touch surface.
          key={hasDetails ? 'details' : 'plain'}
          menuLabel={`Actions for ${displayName}`}
          menuItems={menuItems}
          {...(hasDetails
            ? {
                as: 'button' as const,
                ref: headerRef,
                onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                  if (expanded) collapse(event.currentTarget)
                  else open()
                },
                'aria-expanded': expanded,
                'aria-controls': expanded ? detailsId : undefined,
                'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${displayName} details`,
              }
            : { 'aria-label': `${displayName} (no details)` })}
          data-tool-label={label}
          className="group"
          meta={
            <>
              {elapsedMs !== undefined && <span>{formatMetaDuration(elapsedMs)}</span>}
              {hasDetails ? (
                <ChevronRight
                  size={12}
                  className={`shrink-0 transition-transform duration-(--motion-fast) ease-(--ease-out) ${expanded ? 'rotate-90' : ''}`}
                  aria-hidden
                />
              ) : (
                <span className="w-3 shrink-0" aria-hidden="true" />
              )}
            </>
          }
        >
          <span className="shrink-0 font-mono font-medium text-(--color-text)">{displayName}</span>
          {visibleHeader && (
            <span className="min-w-0 truncate font-mono text-(--color-text-2)">{visibleHeader}</span>
          )}
          {diffStats && (diffStats.additions > 0 || diffStats.deletions > 0) && (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono select-none">
              {diffStats.additions > 0 && <span className="text-(--color-diff-add-text)">+{diffStats.additions}</span>}
              {diffStats.deletions > 0 && <span className="text-(--color-diff-del-text)">−{diffStats.deletions}</span>}
            </span>
          )}
          {state === 'running' ? (
            <span className="oa-shimmer shrink-0">running…</span>
          ) : null}
        </ToolRow>
        {(previewTarget || planLink || imageRead || sentSession) && (
          <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1">
        {previewTarget && (
          <button
            type="button"
            onClick={() => requestOpenPreview(previewTarget)}
            className={TOOL_CHIP_CLASS}
          >
            <Globe size={12} aria-hidden="true" />
            Open preview
          </button>
        )}
        {planLink && (
          <button
            type="button"
            onClick={() => dispatchAppEvent(APP_EVENTS.openPlan)}
            className={TOOL_CHIP_CLASS}
          >
            <FileText size={12} aria-hidden="true" />
            {planLink}
          </button>
        )}
        {imageRead && <ImageViewChip path={imageRead.path} />}
        {sentSession && (
          <Tooltip className="max-w-[60%]">
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => requestOpenSession({ sessionId: sentSession.sessionId, workspace: sentSession.workspace })}
                  className={cn(TOOL_CHIP_CLASS, 'ml-0 max-w-full')}
                >
                  <ArrowUpRight size={12} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">Open in {sentSession.workspaceName}</span>
                </button>
              }
            />
            <TooltipContent>{`Switch to the session in ${sentSession.workspace}`}</TooltipContent>
          </Tooltip>
        )}
        {sentSession?.createdWorktree && (
          <span
            className="inline-flex max-w-[60%] items-center gap-1 align-middle text-meta text-(--color-text-muted)"
            data-created-worktree=""
          >
            <GitBranch size={12} aria-hidden="true" className="shrink-0 text-(--accent-orange-text)" />
            <span className="truncate">
              Created worktree <span className="font-mono">{sentSession.createdWorktree.name}</span>
              {sentSession.createdWorktree.branch && <> on <span className="font-mono">{sentSession.createdWorktree.branch}</span></>}
            </span>
          </span>
        )}
          </div>
        )}
        {teamMember && <RosterSubagentRow handle={teamMember} className="mb-0.5" />}
      </div>

      {/* Expandable details — divider then warm paper body per pencil LJOUY */}
      {/* The shared fold (grid rows, no per-frame measuring), as every
          other fold in the transcript. */}
      <Collapsible open={expanded && hasDetails} id={detailsId}>
            <section className="group relative mt-1 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-input)">
              {awaitingArgs && (usesDiffView || !formattedArgs) && (
                <div>
                  <SectionHeader label="arguments" controls={detailsId} onCollapse={collapse} />
                  <p className="bg-(--bg-input) px-3 py-2.5 text-xs text-(--color-text-muted)" role="status">
                    {remoteArgs.error ? `Could not load the arguments: ${remoteArgs.error}` : 'Loading arguments…'}
                  </p>
                </div>
              )}
              {usesDiffView ? (
                fullArgs !== undefined && (
                <DiffView
                  toolName={name}
                  args={fullArgs || ''}
                  result={result}
                  onCollapse={() => setManualExpanded(false)}
                />
                )
              ) : usesReadView ? (
                <ReadView
                  args={args || ''}
                  result={result}
                  loading={remote.loading}
                  onCollapse={() => setManualExpanded(false)}
                />
              ) : (
                <>
                  {/* Args section — caption (closes the row) and Copy sit above the content. */}
                  {formattedArgs && (
                    <div>
                      <SectionHeader
                        label={isShellTerminal ? 'terminal' : 'arguments'}
                        controls={detailsId}
                        onCollapse={collapse}
                        action={<CopyButton label={argsCopyLabel} text={argsCopyText} />}
                      />
                      {isShellTerminal ? (
                        <div className="flex flex-col gap-1 bg-(--bg-input) p-2.5">
                          <pre
                            ref={liveOutputRef}
                            onScroll={handleScroll}
                            className="max-h-40 sm:max-h-64 overflow-auto touch-pan-y whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-text)"
                          >
                            <span className="block"><span className="select-none text-(--color-text-muted)">$ </span><ShellCommand command={formattedArgs} />{shellOutput ? `\n${shellOutput}` : ''}</span>
                          </pre>
                        </div>
                      ) : (
                        <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-all bg-(--bg-input) px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text)">
                          {displayedArgs}
                        </pre>
                      )}
                    </div>
                  )}
                  {targetArg && (
                    <div>
                      <SectionHeader
                        label="arguments"
                        controls={detailsId}
                        onCollapse={collapse}
                        action={<CopyButton label="Copy arguments" text={targetArg} />}
                      />
                      <p className="whitespace-pre-wrap break-all bg-(--bg-input) px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text)">
                        {targetArg}
                      </p>
                    </div>
                  )}

                  {shownLiveOutput && !isShellTerminal && (
                    <div>
                      <SectionHeader
                        label="output"
                        controls={detailsId}
                        onCollapse={collapse}
                        divided={argsShown}
                        action={<CopyButton label="Copy output" text={shownLiveOutput} />}
                      />
                      <pre
                        ref={liveOutputRef}
                        onScroll={handleScroll}
                        className="max-h-40 overflow-auto touch-pan-y sm:max-h-64 whitespace-pre-wrap break-words bg-(--bg-input) px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text)"
                      >
                        {shownLiveOutput}
                      </pre>
                    </div>
                  )}

                  {/* Background-process output owns its PID/status header, so it
                      replaces the generic Result caption rather than nesting below it. */}
                  {awaitingResult && !shownLiveOutput && (
                    <div>
                      <SectionHeader
                        label="result"
                        controls={detailsId}
                        onCollapse={collapse}
                        divided={argsShown}
                      />
                      <p className="bg-(--bg-input) px-3 py-2.5 text-xs text-(--color-text-muted)" role="status">
                        {remote.error ? `Could not load the result: ${remote.error}` : 'Loading result…'}
                      </p>
                    </div>
                  )}
                  {shownResult && !isShellTerminal && (
                    isBackgroundProcess ? (
                      <ToolResult toolName={name} operation={toolOperation} result={shownResult} headerAction={resultCopyButton} onCollapse={() => setManualExpanded(false)} />
                    ) : isScheduleTaskList ? (
                      <ToolResult toolName={name} operation={toolOperation} result={shownResult} />
                    ) : (
                      <div>
                        <SectionHeader
                          label="result"
                          controls={detailsId}
                          onCollapse={collapse}
                          divided={Boolean(argsShown || shownLiveOutput)}
                          action={resultCopyButton}
                        />
                        <div className="bg-(--bg-input) px-3 py-2.5 text-xs leading-relaxed text-(--color-text)">
                          <ToolResult toolName={name} operation={toolOperation} result={shownResult} />
                        </div>
                      </div>
                    )
                  )}
                </>
              )}
            </section>
      </Collapsible>
    </div>
  )
})
