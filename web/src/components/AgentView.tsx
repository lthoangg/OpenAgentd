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

import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import OctobotMascot from '@/assets/brand/octobot-agentd-source.png'

import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Thinking } from './Thinking'
import { ToolCall } from './ToolCall'
import { MCPAppResult } from './MCPAppResult'
import { InboxBubble } from './InboxBubble'
import { CompactionDivider } from './CompactionDivider'
import { AssistantTurn } from './AssistantTurnFooter'
import { PendingMessageQueue } from './PendingMessageQueue'
import { getVisibleTurnWindow, partitionTurns } from '@/utils/turns'
import { latestDirectUserBlockId, mergeBlocks } from '@/utils/blocks'
import { extractSleepPrefix } from '@/utils/format'
import { latestMCPAppResourceBlockIds } from '@/utils/mcp-app-artifacts'
import { useTeamStore } from '@/stores/useTeamStore'
import type { ContentBlock } from '@/api/types'
import { UserBubble } from './AgentView/UserBubble'

const SCROLL_THRESHOLD = 40
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

const BlockRenderer = memo(function BlockRenderer({ block, isStreaming, sessionId, onRevert, latestMCPAppBlockIds, onMentionFileOpen }: { block: ContentBlock; isStreaming: boolean; sessionId?: string; onRevert?: () => void; latestMCPAppBlockIds?: Set<string>; onMentionFileOpen?: (path: string) => void }) {
  switch (block.type) {
    case 'user': {
      // Me check if this is an inbox message (from another agent, not real user)
      const fromAgent = block.extra?.from_agent as string | undefined
      if (fromAgent && fromAgent !== 'user') {
        return <InboxBubble content={block.content} fromAgent={fromAgent} />
      }
      const blockModel = typeof block.extra?.model === 'string' ? block.extra.model : null
      const shell = block.extra?.kind === 'user_shell'
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} onRevert={onRevert} modelId={blockModel} shell={shell} onMentionFileOpen={onMentionFileOpen} mentions={block.extra?.mentions as string[] | undefined} />
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
          isStreaming={isStreaming}
        />
      )
    }
    case 'provider_status': {
      const status = block.extra?.status
      const model = block.extra?.model
      const attempt = block.extra?.attempt
      const maxAttempts = block.extra?.max_attempts
      const delay = block.extra?.delay_seconds
      const errorType = block.extra?.error_type
      const statusCode = block.extra?.status_code
      let message = 'Provider status updated.'
      if (status === 'retrying') {
        const delayText = typeof delay === 'number' ? ` Waiting ${delay.toFixed(1)}s.` : ''
        const errorText = errorType ? ` after ${String(errorType)}${statusCode ? ` ${String(statusCode)}` : ''}` : ''
        message = `Retrying ${String(model ?? 'model')} (${String(attempt ?? '?')}/${String(maxAttempts ?? '?')})${errorText}.${delayText}`
      } else if (status === 'exhausted') {
        const errorText = errorType ? ` after ${String(errorType)}${statusCode ? ` ${String(statusCode)}` : ''}` : ''
        message = `${String(model ?? 'Model')} exhausted retry attempts${errorText}.`
      }
      return <p className="rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-xs text-(--color-text-muted)">{message}</p>
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
          <LazyMarkdownBlock content={block.content} sessionId={sessionId} isStreaming={isStreaming} />
        </div>
      )
    }
    default:
      return null
  }
})

export function AgentView({ blocks, currentBlocks, isWorking, isError, lastError, isContinuing = false, onContinue, emptyState, onMentionFileOpen }: AgentViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // attachedRef: true = follow the stream.
  //   → true:  user sends a message, clicks the button, or scrolls to the bottom
  //   → false: user scrolls up and is no longer at the bottom
  const attachedRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [renderedTurnCount, setRenderedTurnCount] = useState(INITIAL_RENDERED_TURNS)
  const sessionId = useTeamStore((s) => s.sessionId) ?? undefined
  const prevScrollHeightRef = useRef<number | null>(null)
  // Me mirror store _loadingOlder in a ref so the wheel handler can check
  // it synchronously without subscribing to store state changes.
  const loadingOlderRef = useRef(false)
  // Me keep live refs for values the onScroll closure needs to read without
  // requiring the scroll useEffect to re-register its listeners every time
  // hiddenTurnCount or showEarlierTurns identity changes. Stale closures
  // over these caused loadOlderMessages to never fire after a page loaded
  // (the effect re-ran with a fresh hiddenTurnCount > 0, so every
  // subsequent scroll-to-top called showEarlierTurns instead of fetching).
  const hiddenTurnCountRef = useRef(0)
  const showEarlierTurnsRef = useRef<() => void>(() => {})

  const handleRevert = useCallback(() => {
    void useTeamStore.getState().undoTeam().then(async (response) => {
      const message = response?.message
      if (!message || message.role !== 'user' || message.is_summary) return
      window.dispatchEvent(
        new CustomEvent('undo:restore-draft', {
          detail: { content: message.content ?? '', attachments: message.attachments ?? [] },
        }),
      )
    })
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

  // Keep the refs in sync every render so the scroll handler always sees
  // the latest values without needing to re-register listeners.
  hiddenTurnCountRef.current = hiddenTurnCount
  showEarlierTurnsRef.current = showEarlierTurns

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    attachedRef.current = true
    setShowScrollBtn(false)
    if (behavior === 'smooth' && typeof el.scrollTo === 'function') {
      isProgrammaticScrollRef.current = true
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      const handleScrollEnd = () => {
        isProgrammaticScrollRef.current = false
        el.removeEventListener('scrollend', handleScrollEnd)
      }
      el.addEventListener('scrollend', handleScrollEnd)
      setTimeout(() => {
        isProgrammaticScrollRef.current = false
        el.removeEventListener('scrollend', handleScrollEnd)
      }, 500)
    } else {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollHeight
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop

    const onScroll = () => {
      const currentScrollTop = el.scrollTop
      const prevScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = currentScrollTop

      if (isProgrammaticScrollRef.current) return
      const dist = el.scrollHeight - currentScrollTop - el.clientHeight
      const atBottom = dist <= SCROLL_THRESHOLD

      if (atBottom) {
        attachedRef.current = true
        setShowScrollBtn(false)
      } else if (attachedRef.current) {
        // Don't detach when the virtual keyboard opened (viewport shrink, not user scroll).
        if (document.documentElement.hasAttribute('data-keyboard-open')) return

        // We only detach if the user scrolled UP (meaning scrollTop decreased).
        // If scrollTop increased or stayed the same, it could be due to layout/ResizeObserver/smooth scroll
        // and we want to remain attached.
        const isScrollUp = currentScrollTop < prevScrollTop
        if (isScrollUp) {
          attachedRef.current = false
          setShowScrollBtn(true)
        }
      }

      // Load older messages when scrolled to the top.
      if (currentScrollTop <= LOAD_OLDER_THRESHOLD) {
        if (hiddenTurnCountRef.current > 0) {
          showEarlierTurnsRef.current()
        } else if (useTeamStore.getState().hasMore && !loadingOlderRef.current) {
          loadingOlderRef.current = true
          prevScrollHeightRef.current = el.scrollHeight
          pendingRestoreRef.current = true
          void useTeamStore.getState().loadOlderMessages().finally(() => {
            loadingOlderRef.current = false
          })
        }
      }
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [])

  // Me restore scroll position after older messages are prepended.
  // We track a "pending restore" flag separately from blocks.length so
  // that SSE flushes (which also grow blocks) never accidentally trigger
  // a scroll-position restore.
  const pendingRestoreRef = useRef(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pendingRestoreRef.current || prevScrollHeightRef.current === null) return
    pendingRestoreRef.current = false
    attachedRef.current = false
    el.scrollTop = el.scrollHeight - prevScrollHeightRef.current
    prevScrollHeightRef.current = null
  }, [blocks.length, renderedTurnCount])

  // Me single scroll effect — block count or last block text changed
  const lastContent = allBlocks[allBlocks.length - 1]?.content ?? ''
  useEffect(() => {
    const lastBlock = allBlocks[allBlocks.length - 1]
    if (lastBlock && isDirectUserBlock(lastBlock)) {
      attachedRef.current = true
    }
    if (attachedRef.current) scrollToBottom()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalLen, lastContent])

  const isEmpty = visibleBlocks.length === 0 && !isWorking

  useEffect(() => {
    if (!isEmpty) return
    attachedRef.current = true
    setShowScrollBtn(false)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [isEmpty])

  // ResizeObserver: when attached and content grows or viewport resizes, scroll to bottom.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!attachedRef.current) return
      el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div ref={contentRef} className="mx-auto max-w-3xl px-3 py-5 sm:px-4 sm:py-6">
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
                    className="inline-flex min-h-8 items-center gap-1 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-1.5 text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
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
             <div className="mt-3 rounded-sm border border-(--color-error) bg-(--color-error-subtle) px-3 py-2">
               <p className="text-xs text-(--color-error)">{lastError}</p>
             </div>
           )}
         </div>
      </div>
    </div>
    {showScrollBtn && (
        <button
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-16 left-1/2 z-10 -translate-x-1/2 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={16} />
        </button>

    )}
    </div>
  )
}
