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

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight, Copy, Check } from 'lucide-react'
import { ToolResult } from '../ToolResult'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { getToolDisplay } from './display'
import { DiffView } from './DiffView'
import { ReadView } from './ReadView'
import { getDiffStats } from './diffUtils'
import type { ToolCallState } from './types'

interface ToolCallProps {
  name: string
  args?: string
  done?: boolean
  liveOutput?: string
  result?: string // tool response content
  durationMs?: number
  startedAt?: number
}

function isFailedResult(result: string | undefined): boolean {
  if (!result) return false
  const firstLine = result.trimStart().split('\n', 1)[0]?.toLowerCase() ?? ''
  return (
    firstLine.startsWith('[failed') ||
    firstLine.startsWith('[error') ||
    firstLine.includes('exit code 1') ||
    firstLine.includes('exit 1')
  )
}

function formatShellResult(result: string | undefined): { statusLine: string | null; body: string | null } {
  if (!result) return { statusLine: null, body: null }

  const firstNewline = result.indexOf('\n')
  const firstLine = firstNewline >= 0 ? result.slice(0, firstNewline).trim() : result.trim()
  const hasStatusLine = /^\[(Succeeded|Failed|Error)/i.test(firstLine)

  if (!hasStatusLine) {
    return { statusLine: null, body: result }
  }

  const body = firstNewline >= 0 ? result.slice(firstNewline + 1).trimStart() : ''
  return { statusLine: firstLine, body: body || null }
}

function formatToolLabel(name: string): string {
  if (!name) return 'Tool'
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

export function ToolCall({ name, args, done, liveOutput, result, durationMs, startedAt }: ToolCallProps) {
  // Hooks must be called unconditionally — before any early returns
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const [copiedArgs, setCopiedArgs] = useState(false)
  const [copiedResult, setCopiedResult] = useState(false)
  const liveOutputRef = useRef<HTMLPreElement>(null)
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

  const { header, headerTitle, formattedArgs, language, suppressResult } =
    getToolDisplay(name, args)
  const usesDiffView = name === 'edit' || name === 'patch' || name === 'write'
  const usesReadView = name === 'read'
  const diffStats = (usesDiffView || name === 'rm') && args
    ? getDiffStats(name, args, result)
    : null
  // Pending-state header comes from getToolDisplay's no-args branch
  // (e.g. ``recall`` → "Checking memory…", ``team_message`` →
  // "Preparing message…"). Tools without a custom pending header return
  // ``header: null`` from that branch and fall back to the raw tool name
  // below, preserving the previous behaviour for every other tool.
  const visibleHeader = header
  const shownResult = suppressResult ? undefined : result
  const shownLiveOutput = shownResult ? undefined : liveOutput
  const hasReadResult = usesReadView && Boolean(result)
  const isShell = language === 'bash'
  const isShellTerminal = isShell && Boolean(formattedArgs)
  const shellResult = isShell ? formatShellResult(shownResult) : null
  const shellOutput = shellResult?.body ?? shownLiveOutput

  useEffect(() => {
    if (done || !startedAt) return
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [done, startedAt])

  useEffect(() => {
    const el = liveOutputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [shownLiveOutput])

  const handleCopyArgs = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = isShellTerminal
      ? `${formattedArgs}${shellOutput ? `\n${shellOutput}` : ''}`
      : formattedArgs || args || ''
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

  const hasDetails = Boolean(formattedArgs || shownLiveOutput || shownResult || hasReadResult)
  const expanded = manualExpanded ?? Boolean(shownLiveOutput)
  const displayName = name || 'tool'
  const toolLabel = formatToolLabel(displayName)
  const title = headerTitle ? `${toolLabel}: ${headerTitle}` : toolLabel
  const headerClassName = `min-w-0 truncate font-mono text-(--color-text) ${state === 'running' ? 'animate-pulse text-(--color-marker-orange)' : ''}`
  const elapsedMs = durationMs ?? (!done && startedAt ? now - startedAt : undefined)

  return (
    <div className="tool-row-enter my-2">
      {/* Header row — separate from the details container so collapsed tools stay lightweight. */}
      <button
        type="button"
        onClick={() => hasDetails && setManualExpanded(!expanded)}
        className={`group inline-flex max-w-full items-center gap-1.5 py-1 text-left text-xs transition-colors duration-(--motion-fast) ease-(--ease-out) focus-visible:outline-2 focus-visible:outline-(--focus-ring) ${
          hasDetails
            ? 'cursor-pointer text-(--color-text) hover:text-(--color-accent)'
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
          <span className="shrink-0 font-mono text-[10px] text-(--color-text-muted)" title="Duration">
            {formatDuration(elapsedMs)}
          </span>
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
            transition={{ duration: DURATIONS_S.base, ease: EASINGS.out }}
            className="overflow-hidden"
          >
            <section className="surface-raised group relative mt-1 overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card)">
              {usesDiffView ? (
                <DiffView
                  toolName={name}
                  args={args || ''}
                  result={result}
                  onCollapse={() => setManualExpanded(false)}
                />
              ) : usesReadView && result ? (
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
                      <div className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
                          {isShellTerminal ? 'terminal' : 'arguments'}
                        </span>
                        <button
                          onClick={handleCopyArgs}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring) md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100"
                          aria-label="Copy arguments"
                          title="Copy"
                        >
                          {copiedArgs ? (
                            <Check size={12} className="text-(--color-success)" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                      {isShellTerminal ? (
                        <div className="flex flex-col gap-1 p-2.5">
                          <pre
                            ref={shownLiveOutput ? liveOutputRef : undefined}
                            className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-text)"
                          >
                            <span className="select-none text-(--color-text-muted)">$ </span>
                            <span className="text-(--color-accent)">{formattedArgs}</span>
                            {shellOutput ? `\n${shellOutput}` : ''}
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
                        <pre className="overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text)">
                          {formattedArgs}
                        </pre>
                      )}
                    </div>
                  )}

                  {shownLiveOutput && !isShellTerminal && (
                    <div>
                      <div className={`flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3 ${formattedArgs ? 'border-t' : ''}`}>
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
                          output
                        </span>
                      </div>
                      <pre
                        ref={liveOutputRef}
                        className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-text)"
                      >
                        {shownLiveOutput}
                      </pre>
                    </div>
                  )}

                  {/* Result section — same caption treatment as args. */}
                  {shownResult && !isShellTerminal && (
                    <div>
                      <div className={`flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3 ${formattedArgs || shownLiveOutput ? 'border-t' : ''}`}>
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
                          result
                        </span>
                        <button
                          onClick={handleCopyResult}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring) md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100"
                          aria-label="Copy result"
                          title="Copy result"
                        >
                          {copiedResult ? (
                            <Check size={12} className="text-(--color-success)" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                      <div className="px-3 py-2.5 text-xs leading-relaxed text-(--color-text)">
                        <ToolResult toolName={name} result={shownResult} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
