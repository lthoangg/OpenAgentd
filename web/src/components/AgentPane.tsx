/**
 * AgentPane — compact single-agent pane used by the split view.
 *
 * Renders the same ContentBlock[] stream as `AgentView` (see that file for
 * block types) but in a denser layout with a small header (status, lead
 * badge, token totals) for tiling alongside other panes.
 *
 * Blocks are grouped into "turns" via `partitionTurns` (see `utils/turns.ts`):
 * a turn is a contiguous run of non-user blocks. Each finalized turn renders a
 * single `AssistantTurnFooter` (copy + timestamp) via the shared `AssistantTurn`
 * component (see `AssistantTurnFooter.tsx`); only the trailing turn hides its
 * footer while the agent is actively streaming.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

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
import { partitionTurns } from '@/utils/turns'
import { latestDirectUserBlockId, mergeBlocks } from '@/utils/blocks'
import { formatTokens, extractSleepPrefix, formatTime } from '@/utils/format'
import { latestMCPAppResourceBlockIds } from '@/utils/mcp-app-artifacts'
import { useTeamStore } from '@/stores/useTeamStore'
import { findCommittedMentions } from './InputBar.mentions'
import type { AgentStream } from '@/stores/useTeamStore'
import { resolveApiUrl } from '@/api/client'
import type { ContentBlock, MessageAttachment } from '@/api/types'

const SCROLL_THRESHOLD = 40
const USER_SCROLL_DETACH_DELTA = 4

interface AgentPaneProps {
  name: string
  stream: AgentStream
  isLead: boolean
  isContinuing?: boolean
  onContinue?: () => void
}

const USER_COLLAPSE_LINES = 10
const USER_COLLAPSE_CHARS = 700

function isDirectUserBlock(block: ContentBlock): boolean {
  return block.type === 'user' && !block.extra?.from_agent
}

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
function renderMentionSegments(content: string): React.ReactNode[] {
  const ranges = findCommittedMentions(content, null)
  if (ranges.length === 0) return [content]
  const out: React.ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push(content.slice(cursor, r.start))
    const token = content.slice(r.start, r.end)
    const isFolder = token.endsWith('/')
    out.push(
      <span
        key={r.start}
        data-mention-kind={isFolder ? 'directory' : 'file'}
        className={
          isFolder ? 'text-(--accent-orange-text)' : 'text-(--accent-blue-text)'
        }
      >
        {token}
      </span>,
    )
    cursor = r.end
  }
  if (cursor < content.length) out.push(content.slice(cursor))
  return out
}

function UserBubble({ content, timestamp, attachments, onRevert, modelId, shell }: { content: string; timestamp?: Date; attachments?: MessageAttachment[]; onRevert?: () => void; modelId?: string | null; shell?: boolean }) {
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

  return (
    <div
      className="group mb-3 flex justify-end"
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
    >
      <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[85%]">
         {/* Attachments (compact) */}
         {attachments && attachments.length > 0 && (
           <div className="flex flex-wrap justify-end gap-1.5">
             {attachments.map((att: MessageAttachment, idx: number) => {
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

          <div className={`relative min-w-0 max-w-full overflow-hidden rounded-sm border px-3 py-2 text-xs leading-relaxed text-(--color-text) shadow-sm ${shell ? 'border-(--accent-blue)/30 bg-(--bg-key)' : 'border-(--color-border) bg-(--color-surface)'}`}>
           {/* Expand / collapse button — top-right inside bubble (compact) */}
           {needsCollapse && (
             <button
               onClick={() => setExpanded((v) => !v)}
               aria-expanded={expanded}
               title={expanded ? 'Collapse' : 'Expand'}
               className="absolute top-1 right-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-2) transition-all duration-150 hover:text-(--color-text) active:scale-90"
             >
               {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
             </button>
           )}
           {shell && (
             <div className="mb-1 flex items-center gap-1 font-mono text-[10px] text-(--color-text-muted)">
               <Terminal size={11} aria-hidden="true" />
               <span>Shell</span>
             </div>
           )}
           <p className={`min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere] ${shell ? 'font-mono' : ''}`}>{renderMentionSegments(visibleContent)}</p>
           {/* Gradient fade at bottom when collapsed */}
           {needsCollapse && !expanded && (
             <div
                className="pointer-events-none absolute inset-x-0 bottom-0 backdrop-blur-[1px]"
               style={{
                 height: '1.9rem',
                 background: 'linear-gradient(to bottom, transparent 0%, var(--color-surface) 90%)',
               }}
             />
           )}
         </div>

         {/* Copy button + timestamp row (compact) */}
          {(timestamp || modelName) && (
            <div className={`flex items-center gap-1 transition-opacity duration-150 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
              {modelName && (
                <span className="mr-1 font-mono text-[10px] text-(--color-text-subtle)" title={modelId ?? undefined}>
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
                  <Undo2 size={10} />
                </button>
              )}
              <button
                onClick={handleCopy}
                className="rounded p-0.5 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
               aria-label="Copy message"
               title="Copy"
             >
               {copied ? (
                 <Check size={10} className="text-(--color-success)" />
               ) : (
                 <Copy size={10} />
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


function BlockRenderer({ block, isStreaming, sessionId, onRevert, latestMCPAppBlockIds }: { block: ContentBlock; isStreaming: boolean; sessionId?: string; onRevert?: () => void; latestMCPAppBlockIds?: Set<string> }) {
  switch (block.type) {
    case 'user': {
      const fromAgent = block.extra?.from_agent as string | undefined
      if (fromAgent && fromAgent !== 'user') {
        return <InboxBubble content={block.content} fromAgent={fromAgent} compact />
      }
      const blockModel = typeof block.extra?.model === 'string' ? block.extra.model : null
      const shell = block.extra?.kind === 'user_shell'
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} onRevert={onRevert} modelId={blockModel} shell={shell} />
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

export function AgentPane({
  name, stream, isLead, isContinuing = false, onContinue,
}: AgentPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionId = useTeamStore((s) => s.sessionId) ?? undefined
  const handleRevert = useCallback(() => {
    void useTeamStore.getState().undoTeam()
  }, [])
  const isWorking = stream.status === 'working'
  const isError   = stream.status === 'error'
  const isOffline = stream.status === 'offline'
  // Me show waiting indicator when a user message exists but the agent hasn't woken yet
  const isPending = !isWorking && !isError && !isOffline && stream.currentBlocks.some(isDirectUserBlock)

  const pinnedRef = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

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

  // Me detect user scroll intent before stream updates can snap the pane back
  // to the bottom. Scroll catches scrollbar/keyboard movement; wheel/touchmove
  // detach immediately when the user starts moving upward.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let lastScrollTop = el.scrollTop
    let lastTouchY: number | null = null
    const updatePinnedFromPosition = () => {
      const atBottom = isAtBottom()
      pinnedRef.current = atBottom
      // Me: only flip state when the boolean actually changes. Calling
      // setState with the current value on every wheel tick still
      // schedules a re-render, which can cascade through MarkdownBlock /
      // ReactMarkdown and re-mount inline media elements mid-playback.
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
      requestAnimationFrame(updatePinnedFromPosition)
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -USER_SCROLL_DETACH_DELTA) detachFromBottom()
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (y == null) return
      if (lastTouchY !== null && y > lastTouchY + USER_SCROLL_DETACH_DELTA) detachFromBottom()
      lastTouchY = y
    }
    const onTouchEnd = () => {
      lastTouchY = null
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [isAtBottom])

  const allBlocks = useMemo(
    () => mergeBlocks(stream.blocks, stream.currentBlocks),
    [stream.blocks, stream.currentBlocks],
  )
  const latestUserBlockId = useMemo(() => latestDirectUserBlockId(allBlocks), [allBlocks])
  const turnItems = useMemo(() => partitionTurns(allBlocks), [allBlocks])
  const latestMCPAppBlockIds = useMemo(() => latestMCPAppResourceBlockIds(allBlocks), [allBlocks])

  // Me single scroll effect — block count or last block text changed
  const lastBlockContent = allBlocks[allBlocks.length - 1]?.content ?? ''
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allBlocks.length, lastBlockContent])

  const isEmpty = allBlocks.length === 0

  useEffect(() => {
    if (!isEmpty) return
    pinnedRef.current = true
    setShowScrollBtn(false)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [isEmpty])

  const borderClass = isError
    ? 'border-(--color-error)'
    : isLead
    ? 'border-(--color-border-strong)'
    : 'border-(--color-border)'
  const headerAccent = isError ? 'border-b-(--color-error)' : isWorking ? 'border-b-(--color-accent)' : isOffline ? 'border-b-(--color-text-subtle)' : isLead ? 'border-b-(--color-border-strong)' : 'border-b-(--color-border)'

  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-lg border bg-(--bg-page) transition-all duration-150 ${borderClass}`}
    >
      {/* Header */}
      <div className={`flex items-center gap-2 border-b px-3 py-2.5 ${headerAccent}`}>
         <div className="flex min-w-0 flex-1 items-center gap-1.5">
           <span className={`truncate text-xs font-semibold ${isLead ? 'text-(--color-text)' : 'text-(--color-text-2)'}`}>
             {name}
           </span>
           {isLead && (
             <span className="shrink-0 rounded-sm bg-(--bg-key) px-1 py-0.5 text-xs text-(--color-accent)">
               lead
             </span>
           )}
         </div>
         <div className="flex items-center gap-1 text-xs text-(--color-text-subtle)">
           {stream.usage.totalTokens > 0 && (
             <span
               className="flex h-7 min-w-7 items-center justify-center rounded-full bg-(--bg-key) px-1.5 font-mono text-[10px] text-(--color-text)"
               title={`Input: ${stream.usage.promptTokens.toLocaleString()} · Output: ${stream.usage.completionTokens.toLocaleString()} · Cache: ${stream.usage.cachedTokens.toLocaleString()}`}
             >
               {formatTokens(stream.usage.promptTokens)}
             </span>
           )}
            <span aria-label={`Agent status: ${stream.status}`} className={`h-1.5 w-1.5 rounded-full ${
             isError ? 'bg-(--color-error)' : isWorking ? 'bg-(--color-accent)' : isOffline ? 'bg-(--color-text-subtle) opacity-50' : 'bg-(--color-success)'
           }`} />
         </div>
       </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {isEmpty && !isWorking && (isError || isOffline) && (
            <div className="flex h-full select-none flex-col items-center justify-center py-8">
              <p className="text-xs text-(--color-text-subtle)">{isError ? stream.lastError || 'Error' : 'Offline'}</p>
            </div>
          )}

         {allBlocks.length > 0 && (
            <div className="space-y-3 px-3 py-3">
               {turnItems.map((item, k) => {
                   if (item.kind === 'user') {
                     return (
                       <BlockRenderer
                         key={item.block.id}
                         block={item.block}
                         isStreaming={false}
                           sessionId={sessionId}
                           onRevert={item.block.id === latestUserBlockId ? handleRevert : undefined}
                           latestMCPAppBlockIds={latestMCPAppBlockIds}
                          />
                     )
                   }
                   // Me only the trailing turn (no user block after) can be "live"
                    const isTrailingTurn = k === turnItems.length - 1
                   return (
                     <AssistantTurn
                       key={`turn-${item.startIndex}-${item.blocks[0]?.id ?? k}`}
                       blocks={item.blocks}
                       startIndex={item.startIndex}
                       finalizedCount={stream.blocks.length}
                       isWorking={isWorking}
                        isTrailingTurn={isTrailingTurn}
                        totalBlocks={allBlocks.length}
                        onContinue={onContinue}
                        renderBlock={({ block, isStreaming }) => (
                         <BlockRenderer
                           block={block}
                           isStreaming={isStreaming}
                            sessionId={sessionId}
                            latestMCPAppBlockIds={latestMCPAppBlockIds}
                          />
                       )}
                     />
                   )
                  })}
              </div>
            )}

          {/* Me show dots when pending (user sent, agent not woken) or working with no agent content yet.
            * `[].every()` returns true, so the working branch also requires a non-empty
            * currentBlocks list — otherwise dots persist after `done` flushes the buffer
            * if a stale `working` status briefly survives. */}
          {(isPending ||
            (isWorking && (
              (isContinuing && stream.currentBlocks.length === 0) ||
              (stream.currentBlocks.length > 0 && stream.currentBlocks.every((b) => b.type === 'user'))
            ))) && (
            <div className="flex items-center gap-1.5 px-3 pt-3" role="status" aria-label={`${name} is preparing a response`}>
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '0ms' }} />
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '150ms' }} />
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '300ms' }} />
            </div>
          )}

          {isError && stream.lastError && (
           <div className="mx-3 mt-3 rounded-lg border border-(--color-error) bg-(--color-error-subtle) px-3 py-2">
             <p className="text-xs text-(--color-error)">{stream.lastError}</p>
           </div>
          )}
      </div>
      {showScrollBtn && (
        <button
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-(--color-border) bg-(--bg-card) p-1 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={16} />
        </button>
      )}
      </div>
    </div>
  )
}
