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
import { ChevronDown, ChevronUp, Copy, Check, Undo2 } from 'lucide-react'
import { Thinking } from './Thinking'
import { ToolCall } from './ToolCall'
import { InboxBubble } from './InboxBubble'
import { CompactionDivider } from './CompactionDivider'
import { StreamingCursor } from './motion'
import { ImageAttachment } from './ImageAttachment'
import { FileCard } from './FileCard'
import { AssistantTurn } from './AssistantTurnFooter'
import { partitionTurns } from '@/utils/turns'
import { extractSleepPrefix, formatTime } from '@/utils/format'
import { useTeamStore } from '@/stores/useTeamStore'
import type { ContentBlock, MessageAttachment } from '@/api/types'

const SCROLL_THRESHOLD = 40
const LOAD_OLDER_THRESHOLD = 300

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
}

const USER_COLLAPSE_LINES = 10
const USER_COLLAPSE_CHARS = 700

function UserBubble({ content, timestamp, attachments, onRevert }: { content: string; timestamp?: Date; attachments?: MessageAttachment[]; onRevert?: () => void }) {
  const [showTime, setShowTime] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

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
      className="group mb-4 flex justify-end"
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
    >
      <div className="flex max-w-[78%] flex-col items-end gap-2">
         {/* Attachments */}
         {attachments && attachments.length > 0 && (
           <div className="flex flex-wrap justify-end gap-2">
             {attachments.map((att: MessageAttachment, idx: number) => {
               const isImage = att.category === 'image'

               if (isImage) {
                 return (
                   <ImageAttachment
                     key={idx}
                     src={att.url || ''}
                     alt={att.original_name || `Attachment ${idx + 1}`}
                   />
                 )
               }

               return (
                 <FileCard
                   key={idx}
                   name={att.original_name || att.filename || `File ${idx + 1}`}
                   mediaType={att.media_type}
                   url={att.url}
                   clickable={!!att.url}
                 />
               )
             })}
           </div>
         )}

          <div className="relative overflow-hidden rounded-lg rounded-br-sm border border-(--color-border) bg-(--color-surface) px-4 py-3 text-sm leading-relaxed text-(--color-text) shadow-sm">
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
           <p className="break-words whitespace-pre-wrap">{visibleContent}</p>
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
         {timestamp && (
           <div className={`flex items-center gap-1.5 transition-opacity duration-150 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
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
             <span
               className="text-xs text-(--color-text-subtle)"
               aria-hidden={!showTime}
               title={formatTime(timestamp)}
             >
               {formatTime(timestamp)}
             </span>
           </div>
         )}
      </div>
    </div>
  )
}


function BlockRenderer({ block, isStreaming, isLast, sessionId, showCursor = true, onRevert }: { block: ContentBlock; isStreaming: boolean; isLast: boolean; sessionId?: string; showCursor?: boolean; onRevert?: () => void }) {
  switch (block.type) {
    case 'user': {
      // Me check if this is an inbox message (from another agent, not real user)
      const fromAgent = block.extra?.from_agent as string | undefined
      if (fromAgent && fromAgent !== 'user') {
        return <InboxBubble content={block.content} fromAgent={fromAgent} />
      }
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} onRevert={onRevert} />
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
    case 'tool':
      return (
        <ToolCall
          name={block.toolName || ''}
          args={block.toolArgs}
          done={block.toolDone}
          liveOutput={block.toolOutput}
          result={block.toolResult}
        />
      )
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
          {showCursor && isStreaming && isLast && (
            <StreamingCursor className="ml-0.5 text-(--color-accent)" />
          )}
        </div>
      )
    }
    default:
      return null
  }
}

export function AgentView({ blocks, currentBlocks, isWorking, isError, lastError, isContinuing = false, onContinue, emptyState }: AgentViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const sessionId = useTeamStore((s) => s.sessionId) ?? undefined
  const prevScrollHeightRef = useRef<number | null>(null)
  // Me mirror store _loadingOlder in a ref so the wheel handler can check
  // it synchronously without subscribing to store state changes.
  const loadingOlderRef = useRef(false)

  const handleRevert = useCallback(() => {
    void useTeamStore.getState().undoTeam()
  }, [])

  const allBlocks = useMemo(() => [...blocks, ...currentBlocks], [blocks, currentBlocks])
  const totalLen = allBlocks.length
  const latestUserBlockId = [...allBlocks].reverse().find(isDirectUserBlock)?.id
  const turnItems = useMemo(() => partitionTurns(allBlocks), [allBlocks])

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

  // Me detect user scroll via wheel/touchmove — never fires from programmatic scroll
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onUserScroll = () => {
      // Me: check + arm the load flag synchronously on the event, before any
      // rAF. Multiple wheel events fire before a single rAF executes, so if
      // the guard lived inside rAF all queued callbacks would see the flag as
      // false and fire duplicate requests.
      if (el.scrollTop <= LOAD_OLDER_THRESHOLD && useTeamStore.getState().hasMore && !loadingOlderRef.current) {
        loadingOlderRef.current = true
        prevScrollHeightRef.current = el.scrollHeight
        pendingRestoreRef.current = true
        void useTeamStore.getState().loadOlderMessages().finally(() => {
          loadingOlderRef.current = false
        })
      }

      requestAnimationFrame(() => {
        const atBottom = isAtBottom()
        pinnedRef.current = atBottom
        // Me: only flip state when the boolean actually changes. Calling
        // setState with the current value on every wheel tick still
        // schedules a re-render, which cascades through MarkdownBlock /
        // ReactMarkdown and was enough to re-mount inline ``<video>``
        // elements mid-playback (flicker).
        setShowScrollBtn((prev) => (prev === !atBottom ? prev : !atBottom))
      })
    }
    el.addEventListener('wheel', onUserScroll, { passive: true })
    el.addEventListener('touchmove', onUserScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onUserScroll)
      el.removeEventListener('touchmove', onUserScroll)
    }
  }, [isAtBottom])

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks.length])

  // Me single scroll effect — block count or last block text changed
  const lastContent = allBlocks[allBlocks.length - 1]?.content ?? ''
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalLen, lastContent])

  const isEmpty = totalLen === 0 && !isWorking

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
              {turnItems.map((item, k) => {
                 if (item.kind === 'user') {
                   return (
                     <BlockRenderer
                       key={item.block.id}
                       block={item.block}
                       isStreaming={false}
                        isLast={item.index === allBlocks.length - 1}
                        sessionId={sessionId}
                        onRevert={item.block.id === latestUserBlockId ? handleRevert : undefined}
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
                     finalizedCount={blocks.length}
                     isWorking={isWorking}
                     isTrailingTurn={isTrailingTurn}
                      totalBlocks={allBlocks.length}
                      size="roomy"
                      onContinue={onContinue}
                      renderBlock={({ block, isStreaming, isLast }) => (
                       <BlockRenderer
                         block={block}
                         isStreaming={isStreaming}
                          isLast={isLast}
                          sessionId={sessionId}
                          showCursor={!isContinuing}
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
        className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-(--color-border) bg-(--bg-card) p-1.5 text-(--color-text-muted) shadow-sm transition-colors hover:text-(--color-text-2)"
        aria-label="Scroll to bottom"
      >
        <ChevronDown size={14} />
      </button>
    )}
    </div>
  )
}
