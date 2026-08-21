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
 * Running state is carried by subtle header animation; result content carries
 * success/failure details.
 *
 * The per-tool header/args customisation lives in ``./display.tsx``;
 * this module owns only the chrome (collapse, copy, motion).
 */

import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight, Copy, Check } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ToolResult } from '../ToolResult'
import { AskUser } from '../AskUser'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { tokenizeCode } from '@/utils/code-highlight'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { getToolDisplay } from './display'
import { DiffView } from './DiffView'
import { ReadView } from './ReadView'
import { getDiffStats } from './diffUtils'
import { isFailedResult } from './toolResultStatus'
import type { ToolCallState } from './types'

/** Matches ``app.agent.agent_loop.core.ASK_USER``. */
const ASK_USER = 'ask_user'

interface ToolCallProps {
  name: string
  args?: string
  done?: boolean
  liveOutput?: string
  result?: string // tool response content
  durationMs?: number
  startedAt?: number
  /** Needed by ``ask_user`` to match the call against the open question. */
  toolCallId?: string
}

function formatShellResult(result: string | undefined): { statusLine: string | null; body: string | null } {
  if (!result) return { statusLine: null, body: null }

  const firstNewline = result.indexOf('\n')
  const firstLine = firstNewline >= 0 ? result.slice(0, firstNewline).trim() : result.trim()
  const hasStatusLine = /^\[(Succeeded|Failed|Error|Timed out)/i.test(firstLine)

  if (!hasStatusLine) {
    return { statusLine: null, body: result }
  }

  const body = firstNewline >= 0 ? result.slice(firstNewline + 1).trimStart() : ''
  return { statusLine: firstLine, body: body || null }
}

function formatToolLabel(name: string): string {
  if (!name) return 'Tool'
  if (name === 'lsp') return 'LSP'
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
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

const MAX_LIVE_LINES = 100

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

export const ToolCall = memo(function ToolCall({ name, args, done, liveOutput, result, durationMs, startedAt, toolCallId }: ToolCallProps) {
  // Hooks must be called unconditionally — before any early returns
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  // Reduced motion: snap the disclosure open/closed instead of animating
  // height. Also skips framer's per-frame height measurement of the details
  // subtree, which can be a large diff.
  const prefersReducedMotion = useReducedMotion()
  const [copiedArgs, setCopiedArgs] = useState(false)
  const [copiedResult, setCopiedResult] = useState(false)
  const liveOutputRef = useRef<HTMLPreElement>(null)
  const isAttachedRef = useRef(true)
  const [now, setNow] = useState(() => Date.now())

  // Determine status: start (name only) → running (args) → success/failed (result)
  const isPending = args === undefined || args === null
  const isRunning = !isPending && !done
  const state: ToolCallState = isPending
    ? 'start'
    : isRunning
      ? 'running'
      : isFailedResult(result)
        ? 'failed'
        : 'success'

  // Me: getToolDisplay/getDiffStats are pure functions of (name, args,
  // result) — memoize them so ToolCall's own 1s elapsed-timer tick
  // (`now`, below) doesn't re-run a full JSON.parse and, for edit/patch/
  // write, an O(oldLines*newLines) diff on every tick for the entire
  // lifetime of a running tool call just to redraw the duration label.
  const { header, headerTitle, formattedArgs, language, suppressResult } =
    useMemo(() => getToolDisplay(name, args), [name, args])
  const displayedArgs = useMemo(() => {
    if (!formattedArgs) return ''
    const parsed = tryParseJSON(formattedArgs)
    if (parsed !== null && typeof parsed === 'object') {
      const cleaned = parseJsonStrings(parsed)
      return JSON.stringify(cleaned, null, 2)
    }
    return formattedArgs
  }, [formattedArgs])
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
  // Pending-state header comes from getToolDisplay's no-args branch
  // (e.g. ``recall`` → "Checking memory…", ``team_message`` →
  // "Preparing message…"). Tools without a custom pending header return
  // ``header: null`` from that branch and fall back to the raw tool name
  // below, preserving the previous behaviour for every other tool.
  const visibleHeader = header
  const shownResult = suppressResult ? undefined : result
  const rawLiveOutput = (suppressResult || shownResult) ? undefined : liveOutput
  const shownLiveOutput = done ? rawLiveOutput : clampLiveOutput(rawLiveOutput)
  const hasReadResult = usesReadView
  const isBackgroundProcess = name === 'bg'
  const isScheduleTaskList = name === 'schedule_task' && shownResult?.startsWith('Scheduled tasks (')
  const isShell = language === 'bash'
  const isShellTerminal = isShell && Boolean(formattedArgs)
  const shellResult = isShell ? formatShellResult(shownResult) : null
  const shellOutput = shellResult?.body ?? shownLiveOutput

  useEffect(() => {
    if (done || !startedAt) return
    const tick = () => {
      if (typeof document === 'undefined' || !document.hidden) {
        setNow(Date.now())
      }
    }
    const id = window.setInterval(tick, 1000)
    const handleVisibility = () => {
      if (typeof document === 'undefined' || !document.hidden) setNow(Date.now())
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', handleVisibility) }
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

  const handleCopyArgs = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = isShellTerminal
      ? `${formattedArgs}${shellOutput ? `\n${shellOutput}` : ''}`
      : displayedArgs || args || ''
    try {
      await navigator.clipboard.writeText(text)
      setCopiedArgs(true)
      setTimeout(() => setCopiedArgs(false), 1500)
    } catch {
      // ignore
    }
  }

  const handleCopyResult = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = result || ''
    try {
      await navigator.clipboard.writeText(text)
      setCopiedResult(true)
      setTimeout(() => setCopiedResult(false), 1500)
    } catch {
      // ignore
    }
  }

  const resultCopyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            onClick={handleCopyResult}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40 md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            aria-label="Copy result"
          >
            {copiedResult ? (
              <Check size={12} className="text-(--color-success)" />
            ) : (
              <Copy size={12} />
            )}
          </button>
        }
      />
      <TooltipContent>Copy result</TooltipContent>
    </Tooltip>
  )

  const hasDetails = Boolean(formattedArgs || shownLiveOutput || shownResult || hasReadResult)
  const expanded = manualExpanded ?? Boolean(shownLiveOutput)
  const displayName = name || 'tool'
  const toolLabel = formatToolLabel(displayName)
  const title = headerTitle ? `${toolLabel}: ${headerTitle}` : toolLabel
  const headerClassName = `min-w-0 truncate font-mono text-(--color-text) ${
    state === 'running'
      ? 'animate-pulse text-(--color-marker-orange)'
      : state === 'failed'
        ? 'text-(--color-error)'
        : ''
  }`
  const elapsedMs = durationMs ?? (!done && startedAt ? now - startedAt : undefined)

  // ``ask_user`` owns its whole card — frame and label included, since
  // both track whether the question is still open. An unanswered question must
  // not be hidden behind a disclosure triangle, and once answered it is a
  // two-line summary with nothing to collapse. It also must not show the
  // persisted "waiting for the user" placeholder as a finished tool result.
  if (name === ASK_USER) {
    return <AskUser toolCallId={toolCallId} args={args} result={result} />
  }

  return (
    <div className="tool-row-enter my-2">
      {/* Header row — separate from the details container so collapsed tools stay lightweight. */}
      <button
        type="button"
        onClick={() => hasDetails && setManualExpanded(!expanded)}
        className={`group inline-flex max-w-full items-center gap-1.5 py-1 text-left text-xs transition-colors duration-(--motion-fast) ease-(--ease-out) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40 ${
          hasDetails
            ? 'cursor-pointer text-(--color-text) hover:text-(--color-text)'
            : 'cursor-default'
        }`}
        aria-expanded={expanded}
        aria-label={
          hasDetails
            ? expanded
              ? `Collapse ${displayName} details`
              : `Expand ${displayName} details`
            : `${displayName} (no details)`
        }
      >
        {/* Header content: tool-specific summary or fallback to tool name.
            Mono+600 per pencil dqwZw. */}
        <span className={headerClassName} title={title}>
          <span className="font-semibold">{toolLabel}</span>
          {visibleHeader && (
            <>
              <span>: </span>
              <span title={headerTitle ?? undefined}>{visibleHeader}</span>
            </>
          )}
          {diffStats && (
            <span className="ml-2 inline-flex items-center gap-1 font-semibold select-none">
              {diffStats.additions > 0 && (
                <span className="text-[var(--color-diff-add-text)]">+{diffStats.additions}</span>
              )}
              {diffStats.deletions > 0 && (
                <span className="text-[var(--color-diff-del-text)]">-{diffStats.deletions}</span>
              )}
            </span>
          )}
        </span>

        {elapsedMs !== undefined && (
          <span className="shrink-0 font-mono text-[10px] text-(--color-text-muted)">{formatDuration(elapsedMs)}</span>
        )}

        {hasDetails && (
          <ChevronRight
            size={13}
            className={`shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ease-(--ease-out) ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          />
        )}
      </button>

      {/* Expandable details — divider then warm paper body per pencil LJOUY */}
      <AnimatePresence initial={false}>
        {expanded && hasDetails && (
          <motion.div
            key="tool-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : DURATIONS_S.base, ease: EASINGS.out }}
            className="overflow-hidden"
          >
            <section className="surface-raised group relative mt-1 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-input)">
              {usesDiffView ? (
                <DiffView
                  toolName={name}
                  args={args || ''}
                  result={result}
                  onCollapse={() => setManualExpanded(false)}
                />
              ) : usesReadView ? (
                <ReadView
                  args={args || ''}
                  result={result}
                  onCollapse={() => setManualExpanded(false)}
                />
              ) : (
                <>
                  {/* Args section — caption + copy sit above the content. */}
                  {formattedArgs && (
                    <div>
                      <div onClick={() => setManualExpanded(false)} className="group/result-header flex cursor-pointer items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) py-0.5 pr-1.5 pl-3 transition-colors hover:text-(--color-text)">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted) transition-colors group-hover/result-header:text-(--color-text)">
                          {isShellTerminal ? 'terminal' : 'arguments'}
                        </span>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                onClick={handleCopyArgs}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40 md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                                aria-label="Copy arguments"
                              >
                                {copiedArgs ? (
                                  <Check size={12} className="text-(--color-success)" />
                                ) : (
                                  <Copy size={12} />
                                )}
                              </button>
                            }
                          />
                          <TooltipContent>Copy</TooltipContent>
                        </Tooltip>
                      </div>
                      {isShellTerminal ? (
                        <div className="flex flex-col gap-1 bg-(--bg-input) p-2.5">
                          <pre
                            ref={liveOutputRef}
                            onScroll={handleScroll}
                            className="max-h-40 sm:max-h-64 overflow-auto touch-pan-y whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-text)"
                          >
                            <span className="block"><span className="select-none text-(--color-text-muted)">$ </span><ShellCommand command={formattedArgs} />{shellOutput ? `\n${shellOutput}` : ''}</span>
                          </pre>
                          {shellResult?.statusLine && (
                            <span
                              className={`font-mono text-[11px] font-medium ${
                                shellResult.statusLine.startsWith('[Succeeded')
                                  ? 'text-(--color-success)'
                                  : 'text-(--color-error)'
                              }`}
                            >
                              {shellResult.statusLine}
                            </span>
                          )}
                        </div>
                      ) : (
                        <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-all bg-(--bg-input) px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text)">
                          {displayedArgs}
                        </pre>
                      )}
                    </div>
                  )}

                  {shownLiveOutput && !isShellTerminal && (
                    <div>
                      <div onClick={() => setManualExpanded(false)} className={`group/result-header flex cursor-pointer items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) py-0.5 pr-1.5 pl-3 transition-colors hover:text-(--color-text) ${formattedArgs ? 'border-t' : ''}`}>
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted) transition-colors group-hover/result-header:text-(--color-text)">
                          output
                        </span>
                      </div>
                      <pre
                        ref={liveOutputRef}
                        onScroll={handleScroll}
                        className="max-h-40 overflow-auto touch-pan-y sm:max-h-64 whitespace-pre-wrap break-words bg-(--bg-input) px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-text)"
                      >
                        {shownLiveOutput}
                      </pre>
                    </div>
                  )}

                  {/* Background-process output owns its PID/status header, so it
                      replaces the generic Result caption rather than nesting below it. */}
                  {shownResult && !isShellTerminal && (
                    isBackgroundProcess ? (
                      <ToolResult toolName={name} operation={toolOperation} result={shownResult} headerAction={resultCopyButton} onCollapse={() => setManualExpanded(false)} />
                    ) : isScheduleTaskList ? (
                      <ToolResult toolName={name} operation={toolOperation} result={shownResult} />
                    ) : (
                      <div>
                        <div onClick={() => setManualExpanded(false)} className={`group/result-header flex cursor-pointer items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) py-0.5 pr-1.5 pl-3 transition-colors hover:text-(--color-text) ${formattedArgs || shownLiveOutput ? 'border-t' : ''}`}>
                          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted) transition-colors group-hover/result-header:text-(--color-text)">
                            result
                          </span>
                          {resultCopyButton}
                        </div>
                        <div className="bg-(--bg-input) px-3 py-2.5 text-xs leading-relaxed text-(--color-text)">
                          <ToolResult toolName={name} operation={toolOperation} result={shownResult} />
                        </div>
                      </div>
                    )
                  )}
                </>
              )}
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})
