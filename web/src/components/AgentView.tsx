/**
 * AgentView — single-agent full-width view (viewMode === 'agent').
 *
 * Renders a flat ContentBlock[] stream (finalized + live) with:
 * - type:'user'    → yellow user bubble
 * - type:'thinking' → collapsible thinking block
 * - type:'tool'    → tool call card
 * - type:'text'    → markdown prose
 *
 * Blocks are grouped into "turns" via `partitionTurns` (see `utils/turns.ts`):
 * a turn is a contiguous run of non-user blocks. Each finalized turn renders a
 * single `AssistantTurnFooter` (copy + timestamp); only the trailing turn hides
 * its footer while the agent is actively streaming. The same shared
 * `AssistantTurn` component (see `AssistantTurnFooter.tsx`) is used by
 * `AgentPane` for split/unified modes.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import OctobotMascot from '@/assets/brand/octobot-agentd-source.png'

import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { ChevronDown, ChevronUp, Copy, Check, Undo2, Terminal } from 'lucide-react'
import { Thinking } from './Thinking'
import { ToolCall } from './ToolCall'
import { MCPAppResult } from './MCPAppResult'
import { InboxBubble } from './InboxBubble'
import { CompactionDivider } from './CompactionDivider'
import { ImageAttachment } from './ImageAttachment'
import { FileCard } from './FileCard'
import { AssistantTurn } from './AssistantTurnFooter'
import { PendingMessageQueue } from './PendingMessageQueue'
import { getVisibleTurnWindow, partitionTurns } from '@/utils/turns'
import { latestDirectUserBlockId, mergeBlocks } from '@/utils/blocks'
import { extractSleepPrefix, formatTime } from '@/utils/format'
import { latestMCPAppResourceBlockIds } from '@/utils/mcp-app-artifacts'
import { useTeamStore } from '@/stores/useTeamStore'
import { findCommittedMentions } from './InputBar.mentions'
import { resolveApiUrl } from '@/api/client'
import type { ContentBlock, MessageAttachment } from '@/api/types'

const SCROLL_THRESHOLD = 40
const USER_SCROLL_DETACH_DELTA = 4
const LOAD_OLDER_THRESHOLD = 300
const INITIAL_RENDERED_TURNS = 80
const TURN_RENDER_STEP = 80

function isDirectUserBlock(block: ContentBlock): boolean {
  return block.type === 'user' && !block.extra?.from_agent
}

interface AgentViewProps {
  /** Finalized blocks from previous turns. */
  blocks: ContentBlock[]
  /** Live blocks accumulating in the current turn. */
  currentBlocks: ContentBlock[]
  /** True while the agent is actively streaming. */
  isWorking: boolean
  /** True when the agent is in error state. */
  isError?: boolean
  /** Error message to display when isError is true. */
  lastError?: string | null
  /** True while this turn was started by /continue. */
  isContinuing?: boolean
  /** Continue from the trailing assistant turn. */
  onContinue?: () => void
  /** Optional slot rendered in place of the default mascot empty state. */
  emptyState?: React.ReactNode
  /** Open a mentioned workspace file in the coding workspace sidebar. */
  onMentionFileOpen?: (path: string) => void
}

const USER_COLLAPSE_LINES = 10
const USER_COLLAPSE_CHARS = 700

function shortModelName(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return modelId.split(':').at(-1)?.split('/').at(-1) || modelId
}

/**
 * Render user prose with ``@mention`` tokens syntax-highlighted.
 *
 * Matches the InputBar's overlay convention so a message looks the same
 * after send as it did while composing:
 *   - folders (token ends in ``/``)      → ``--accent-orange-text``
 *   - files (everything else, default)   → ``--accent-blue-text``
 *
 * The slash heuristic is what the picker inserts; using it (rather than
 * resolving against ``fileRefs``) keeps highlighting stable for old
 * messages whose referenced paths may since have been renamed/removed.
 * ``findCommittedMentions`` without refs falls back to syntax-only range
 * detection — same code path the overlay relies on.
 */
function renderMentionSegments(content: string, onMentionFileOpen?: (path: string) => void): React.ReactNode[] {
  const ranges = findCommittedMentions(content, null)
  if (ranges.length === 0) return [content]
  const out: React.ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push(content.slice(cursor, r.start))
    const token = content.slice(r.start, r.end)
    const isFolder = token.endsWith('/')
    const path = token.slice(1)
    out.push(onMentionFileOpen && !isFolder ? (
      <button
        key={r.start}
        type="button"
        data-mention-kind="file"
        onClick={() => onMentionFileOpen(path)}
        className="inline rounded-sm text-(--accent-blue-text) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
      >
        {token}
      </button>
    ) : (
      <span
        key={r.start}
        data-mention-kind={isFolder ? 'directory' : 'file'}
        className={
          isFolder ? 'text-(--accent-orange-text)' : 'text-(--accent-blue-text)'
        }
      >
        {token}
      </span>
    ))
    cursor = r.end
  }
  if (cursor < content.length) out.push(content.slice(cursor))
  return out
}

function UserBubble({ content, timestamp, attachments, onRevert, modelId, shell, onMentionFileOpen }: { content: string; timestamp?: Date; attachments?: MessageAttachment[]; onRevert?: () => void; modelId?: string | null; shell?: boolean; onMentionFileOpen?: (path: string) => void }) {
  const [showTime, setShowTime] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const modelName = shortModelName(modelId)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const lines = content.split('\n')
  const needsCollapse = lines.length > USER_COLLAPSE_LINES || content.length > USER_COLLAPSE_CHARS
  const visibleContent = needsCollapse && !expanded
    ? lines.length > USER_COLLAPSE_LINES
      ? lines.slice(0, USER_COLLAPSE_LINES).join('\n')
      : `${content.slice(0, USER_COLLAPSE_CHARS).trimEnd()}...`
    : content
  const visibleAttachments = attachments?.filter((att) => att.source !== 'mention') ?? []

  return (
    <div
      className="group mb-4 flex justify-end"
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
    >
      <div className="flex max-w-full flex-col items-end gap-2 md:max-w-[78%]">
         {/* Attachments */}
         {visibleAttachments.length > 0 && (
           <div className="flex flex-wrap justify-end gap-2">
             {visibleAttachments.map((att: MessageAttachment, idx: number) => {
               const isImage = att.category === 'image'

               if (isImage) {
                 return (
                   <ImageAttachment
                     key={idx}
                     src={resolveApiUrl(att.url) || ''}
                     alt={att.original_name || `Attachment ${idx + 1}`}
                   />
                 )
               }

               return (
                 <FileCard
                   key={idx}
                   name={att.original_name || att.filename || `File ${idx + 1}`}
                   mediaType={att.media_type}
                   url={resolveApiUrl(att.url)}
                   clickable={!!att.url}
                 />
               )
             })}
           </div>
         )}

          <div className={`relative min-w-0 max-w-full overflow-hidden rounded-sm border px-4 py-3 text-sm leading-relaxed text-(--color-text) shadow-sm selectable-text ${shell ? 'border-(--accent-blue)/30 bg-(--bg-key)' : 'border-(--color-border) bg-(--color-surface)'}`}>
           {/* Expand / collapse button — top-right inside bubble */}
           {needsCollapse && (
             <button
               onClick={() => setExpanded((v) => !v)}
               aria-expanded={expanded}
               title={expanded ? 'Collapse' : 'Expand'}
               className="absolute top-1.5 right-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-2) transition-all duration-150 hover:text-(--color-text) active:scale-90"
             >
               {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
             </button>
           )}
           {shell && (
             <div className="mb-1.5 flex items-center gap-1 font-mono text-[11px] text-(--color-text-muted)">
               <Terminal size={12} aria-hidden="true" />
               <span>Shell</span>
             </div>
           )}
           <p className={`min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere] ${shell ? 'font-mono' : ''}`}>{renderMentionSegments(visibleContent, onMentionFileOpen)}</p>
           {/* Gradient fade at bottom when collapsed */}
           {needsCollapse && !expanded && (
             <div
                className="pointer-events-none absolute inset-x-0 bottom-0 backdrop-blur-[1px]"
               style={{
                 height: '2.4rem',
                 background: 'linear-gradient(to bottom, transparent 0%, var(--color-surface) 90%)',
               }}
             />
           )}
         </div>

         {/* Copy button + timestamp row */}
          {(timestamp || modelName) && (
            <div className={`flex items-center gap-1.5 transition-opacity duration-150 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
              {modelName && (
                <span className="mr-1 font-mono text-[11px] text-(--color-text-subtle)" title={modelId ?? undefined}>
                  {modelName}
                </span>
              )}
               {onRevert && (
                <button
                  onClick={onRevert}
                  className="rounded p-0.5 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
                  aria-label="Revert latest message"
                  title="Revert latest message"
                >
                  <Undo2 size={11} />
                </button>
              )}
              <button
                onClick={handleCopy}
                className="rounded p-0.5 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
               aria-label="Copy message"
               title="Copy"
             >
               {copied ? (
                 <Check size={11} className="text-(--color-success)" />
               ) : (
                 <Copy size={11} />
               )}
             </button>
              {timestamp && (
                <span
                  className="text-xs text-(--color-text-subtle)"
                  aria-hidden={!showTime}
                  title={formatTime(timestamp)}
                >
                  {formatTime(timestamp)}
                </span>
              )}
            </div>
          )}
      </div>
    </div>
  )
}


function BlockRenderer({ block, isStreaming, sessionId, onRevert, latestMCPAppBlockIds, onMentionFileOpen }: { block: ContentBlock; isStreaming: boolean; sessionId?: string; onRevert?: () => void; latestMCPAppBlockIds?: Set<string>; onMentionFileOpen?: (path: string) => void }) {
  switch (block.type) {
    case 'user': {
      // Me check if this is an inbox message (from another agent, not real user)
      const fromAgent = block.extra?.from_agent as string | undefined
      if (fromAgent && fromAgent !== 'user') {
        return <InboxBubble content={block.content} fromAgent={fromAgent} />
      }
      const blockModel = typeof block.extra?.model === 'string' ? block.extra.model : null
      const shell = block.extra?.kind === 'user_shell'
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} onRevert={onRevert} modelId={blockModel} shell={shell} onMentionFileOpen={onMentionFileOpen} />
    }
    case 'thinking':
      return <Thinking content={block.content} isStreaming={isStreaming} />
    case 'compaction': {
      const state = block.extra?.state === 'compacting' ? 'compacting' : 'compacted'
      const error = Boolean(block.extra?.error)
      return (
        <CompactionDivider
          state={state}
          error={error}
          summary={block.content}
          sessionId={sessionId}
        />
      )
    }
    case 'provider_status': {
      const status = block.extra?.status
      const model = block.extra?.model
      const primary = block.extra?.primary
      const fallback = block.extra?.fallback
      const attempt = block.extra?.attempt
      const maxAttempts = block.extra?.max_attempts
      const delay = block.extra?.delay_seconds
      const errorType = block.extra?.error_type
      const statusCode = block.extra?.status_code
      let message = 'Provider status updated.'
      if (status === 'fallback') {
        message = `Switching model from ${String(primary ?? 'primary')} to ${String(fallback ?? 'fallback')}.`
      } else if (status === 'retrying') {
        const delayText = typeof delay === 'number' ? ` Waiting ${delay.toFixed(1)}s.` : ''
        const errorText = errorType ? ` after ${String(errorType)}${statusCode ? ` ${String(statusCode)}` : ''}` : ''
        message = `Retrying ${String(model ?? 'model')} (${String(attempt ?? '?')}/${String(maxAttempts ?? '?')})${errorText}.${delayText}`
      } else if (status === 'exhausted') {
        const errorText = errorType ? ` after ${String(errorType)}${statusCode ? ` ${String(statusCode)}` : ''}` : ''
        message = `${String(model ?? 'Model')} exhausted retry attempts${errorText}.`
      }
      return <p className="rounded-md border border-(--color-border) bg-(--bg-muted) px-3 py-2 text-xs text-(--color-text-muted)">{message}</p>
    }
    case 'tool': {
      const mcpApp = (block.extra as { mcp_app?: unknown } | undefined)?.mcp_app
      return (
        <div>
          <ToolCall
            name={block.toolName || ''}
            args={block.toolArgs}
            done={block.toolDone}
            liveOutput={block.toolOutput}
            result={block.toolResult}
            durationMs={block.durationMs}
            startedAt={block.startedAt}
          />
          {block.toolDone && Boolean(mcpApp) && latestMCPAppBlockIds?.has(block.id) ? (
            <div className="mt-2">
              <MCPAppResult mcpApp={mcpApp as never} sessionId={sessionId} toolCallId={block.toolCallId} />
            </div>
          ) : null}
        </div>
      )
    }
    case 'text': {
      // Me sleep sentinel — show any preceding content normally, then append idle pill
      const sleepPrefix = extractSleepPrefix(block.content)
      if (sleepPrefix !== null) {
        return (
          <div>
            {sleepPrefix && <LazyMarkdownBlock content={sleepPrefix} sessionId={sessionId} />}
            <p className="text-xs text-(--color-text-subtle) italic">— idle —</p>
          </div>
        )
      }
      return (
        <div>
          <LazyMarkdownBlock content={block.content} sessionId={sessionId} />
        </div>
      )
    }
    default:
      return null
  }
}

export function AgentView({ blocks, currentBlocks, isWorking, isError, lastError, isContinuing = false, onContinue, emptyState, onMentionFileOpen }: AgentViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [renderedTurnCount, setRenderedTurnCount] = useState(INITIAL_RENDERED_TURNS)
  const sessionId = useTeamStore((s) => s.sessionId) ?? undefined
  const prevScrollHeightRef = useRef<number | null>(null)
  // Me mirror store _loadingOlder in a ref so the wheel handler can check
  // it synchronously without subscribing to store state changes.
  const loadingOlderRef = useRef(false)

  const handleRevert = useCallback(() => {
    void useTeamStore.getState().undoTeam()
  }, [])

  const allBlocks = useMemo(() => mergeBlocks(blocks, currentBlocks), [blocks, currentBlocks])
  const visibleBlocks = useMemo(
    () => allBlocks.filter((block) => block.type !== 'compaction'),
    [allBlocks],
  )
  const totalLen = allBlocks.length
  const latestUserBlockId = useMemo(() => latestDirectUserBlockId(allBlocks), [allBlocks])
  const turnItems = useMemo(() => partitionTurns(allBlocks), [allBlocks])
  const { hiddenTurnCount, visibleTurnItems } = useMemo(
    () => getVisibleTurnWindow(turnItems, renderedTurnCount),
    [renderedTurnCount, turnItems],
  )
  const latestMCPAppBlockIds = useMemo(() => latestMCPAppResourceBlockIds(allBlocks), [allBlocks])

  const showEarlierTurns = useCallback(() => {
    const el = scrollRef.current
    if (el) {
      prevScrollHeightRef.current = el.scrollHeight
      pendingRestoreRef.current = true
    }
    setRenderedTurnCount((count) => Math.min(turnItems.length, count + TURN_RENDER_STEP))
  }, [turnItems.length])

  const isAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setShowScrollBtn(false)
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  // Me track scroll position and reveal/fetch older history near the top.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let lastScrollTop = el.scrollTop
    const updatePinnedFromPosition = () => {
      const atBottom = isAtBottom()
      pinnedRef.current = atBottom
      // Me: only flip state when the boolean actually changes. Calling
      // setState with the current value on every scroll tick still
      // schedules a re-render, which cascades through MarkdownBlock /
      // ReactMarkdown and was enough to re-mount inline ``<video>``
      // elements mid-playback (flicker).
      setShowScrollBtn((prev) => (prev === !atBottom ? prev : !atBottom))
    }
    const detachFromBottom = () => {
      pinnedRef.current = false
      setShowScrollBtn(true)
    }
    const onScroll = () => {
      const nextScrollTop = el.scrollTop
      if (nextScrollTop < lastScrollTop - USER_SCROLL_DETACH_DELTA) {
        detachFromBottom()
      }
      lastScrollTop = nextScrollTop
      // Me: check + arm the load flag synchronously on the event, before any
      // rAF. Multiple scroll events can fire before a single rAF executes, so
      // if the guard lived inside rAF all queued callbacks would see the flag
      // as false and fire duplicate requests.
      if (el.scrollTop <= LOAD_OLDER_THRESHOLD) {
        if (hiddenTurnCount > 0) {
          showEarlierTurns()
        } else if (useTeamStore.getState().hasMore && !loadingOlderRef.current) {
          loadingOlderRef.current = true
          prevScrollHeightRef.current = el.scrollHeight
          pendingRestoreRef.current = true
          void useTeamStore.getState().loadOlderMessages().finally(() => {
            loadingOlderRef.current = false
          })
        }
      }

      requestAnimationFrame(updatePinnedFromPosition)
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -USER_SCROLL_DETACH_DELTA) detachFromBottom()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
    }
  }, [hiddenTurnCount, isAtBottom, showEarlierTurns])

  // Me restore scroll position after older messages are prepended.
  // We track a "pending restore" flag separately from blocks.length so
  // that SSE flushes (which also grow blocks) never accidentally trigger
  // a scroll-position restore.
  const pendingRestoreRef = useRef(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pendingRestoreRef.current || prevScrollHeightRef.current === null) return
    pendingRestoreRef.current = false
    el.scrollTop = el.scrollHeight - prevScrollHeightRef.current
    prevScrollHeightRef.current = null
  }, [blocks.length, renderedTurnCount])

  // Me single scroll effect — block count or last block text changed
  const lastContent = allBlocks[allBlocks.length - 1]?.content ?? ''
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalLen, lastContent])

  const isEmpty = visibleBlocks.length === 0 && !isWorking

  useEffect(() => {
    if (!isEmpty) return
    pinnedRef.current = true
    setShowScrollBtn(false)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [isEmpty])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6">
        {isEmpty && (
           emptyState ?? (
             <div className="flex select-none flex-col items-center justify-center gap-4 py-16">
               <img
                 src={OctobotMascot}
                 className="opacity-90"
                 width={120}
                 height={120}
                 alt=""
                 aria-hidden="true"
               />
               <h2 className="font-hand text-4xl font-bold text-(--color-text)">
                 what&rsquo;s on your mind?
               </h2>
             </div>
           )
         )}

         <div className="space-y-3">
              {hiddenTurnCount > 0 && (
                <div className="flex justify-center py-2">
                  <button
                    type="button"
                    onClick={showEarlierTurns}
                    className="inline-flex min-h-10 items-center gap-1 rounded-full border border-(--color-border) bg-(--bg-card) px-3 py-1.5 text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
                    aria-label={`Show ${Math.min(TURN_RENDER_STEP, hiddenTurnCount)} earlier turns`}
                  >
                    <ChevronUp size={13} aria-hidden="true" />
                    Show earlier messages · {hiddenTurnCount} hidden
                  </button>
                </div>
              )}
              {visibleTurnItems.map((item, k) => {
                 const globalTurnIndex = hiddenTurnCount + k
                 if (item.kind === 'user') {
                   return (
                     <BlockRenderer
                       key={item.block.id}
                       block={item.block}
                       isStreaming={false}
                         sessionId={sessionId}
                         onRevert={item.block.id === latestUserBlockId ? handleRevert : undefined}
                         latestMCPAppBlockIds={latestMCPAppBlockIds}
                         onMentionFileOpen={onMentionFileOpen}
                        />
                   )
                 }
                 // Me only the trailing turn (no user block after) can be "live"
                  const isTrailingTurn = globalTurnIndex === turnItems.length - 1
                 return (
                   <AssistantTurn
                     key={`turn-${item.startIndex}-${item.blocks[0]?.id ?? k}`}
                     blocks={item.blocks}
                     startIndex={item.startIndex}
                     finalizedCount={blocks.length}
                     isWorking={isWorking}
                     isTrailingTurn={isTrailingTurn}
                      totalBlocks={allBlocks.length}
                      size="roomy"
                      onContinue={onContinue}
                      renderBlock={({ block, isStreaming }) => (
                       <BlockRenderer
                         block={block}
                            isStreaming={isStreaming}
                            sessionId={sessionId}
                            onRevert={isDirectUserBlock(block) && block.id === latestUserBlockId ? handleRevert : undefined}
                            latestMCPAppBlockIds={latestMCPAppBlockIds}
                         onMentionFileOpen={onMentionFileOpen}
                          />
                     )}
                   />
                 )
                })}

            {/* Me show dots when:
             *   1. pending — user just sent, agent hasn't woken yet (no agent_status event yet), OR
             *   2. working with no agent content yet (user bubbles don't count).
             * Covers the POST → first SSE event gap so the user always gets immediate feedback.
             *
             * Note: `[].every()` returns true, so the working branch must
             * also require a non-empty currentBlocks list — otherwise dots
             * stick around after `done` flushes the buffer if a stale
             * `working` status briefly survives.
             */}
            {((!isWorking && !isError && currentBlocks.some(isDirectUserBlock)) ||
              (isWorking && (
                (isContinuing && currentBlocks.length === 0) ||
                (currentBlocks.length > 0 && currentBlocks.every((b) => b.type === 'user'))
              ))) && (
              <div className="flex items-center gap-1.5 py-1" role="status" aria-label="Agent is preparing a response">
                <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '0ms' }} />
                <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '150ms' }} />
                <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '300ms' }} />
              </div>
            )}

            <PendingMessageQueue />

            {isError && lastError && (
             <div className="mt-3 rounded-lg border border-(--color-error) bg-(--color-error-subtle) px-3 py-2">
               <p className="text-xs text-(--color-error)">{lastError}</p>
             </div>
           )}
         </div>
      </div>
    </div>
    {showScrollBtn && (
        <button
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-16 left-1/2 z-10 -translate-x-1/2 rounded-full border border-(--color-border) bg-(--bg-card) p-1 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={16} />
        </button>

    )}
    </div>
  )
}
