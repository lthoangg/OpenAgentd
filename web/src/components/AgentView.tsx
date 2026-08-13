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
import { appendCurrentTurns, getVisibleTurnWindow, partitionTurns } from '@/utils/turns'
import { latestDirectUserBlockIdFromParts, mergeBlocks } from '@/utils/blocks'
import { extractSleepPrefix } from '@/utils/format'
import { latestMCPAppResourceBlockIdsFromParts, latestMCPAppResources, mcpAppResourceUri } from '@/utils/mcp-app-artifacts'
import { useTeamStore } from '@/stores/useTeamStore'
import type { ContentBlock } from '@/api/types'
import { UserBubble } from './AgentView/UserBubble'

const SCROLL_THRESHOLD = 40
// How long a wheel-up / touch-drag gesture keeps the view detached from the
// stream. During heavy stream growth the auto-follow ResizeObserver rewrites
// scrollTop to the bottom before the scroll listener runs, so scroll events
// alone cannot see the user's upward movement — input events carry the intent.
const USER_SCROLL_INTENT_MS = 250
const LOAD_OLDER_THRESHOLD = 300
/** Keys that move the viewport upward without emitting wheel/touch events. */
const SCROLL_UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp'])
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const INITIAL_RENDERED_TURNS = 80
const TURN_RENDER_STEP = 80

function isDirectUserBlock(block: ContentBlock): boolean {
  return block.type === 'user' && !block.extra?.from_agent
}

/** True for a `thinking`/`text` block that has streamed in only whitespace
 *  so far (e.g. a provider's blank reasoning-section separator, or the
 *  very first chunk before real content arrives). Such a block renders no
 *  visible output, so it must not count as "content has started" when
 *  deciding whether to keep showing the pending dots — otherwise the user
 *  is left staring at a blank chat area with no dots and no content. */
function isBlankContentBlock(block: ContentBlock): boolean {
  return (block.type === 'thinking' || block.type === 'text') && block.content.trim().length === 0
}

interface AgentViewProps {
  /** Finalized blocks from previous turns. */
  blocks: ContentBlock[]
  /** Live blocks accumulating in the current turn. */
  currentBlocks: ContentBlock[]
  /** True while the agent is actively streaming. */
  isWorking: boolean
  /**
   * True while the turn has not ended — a superset of ``isWorking`` that also
   * covers a lead suspended on ``ask_user``. Nothing streams then, but the turn
   * is open, so it must not show a duration, a Continue, or "about to respond"
   * dots. Defaults to ``isWorking``.
   */
  isTurnOpen?: boolean
  /**
   * The turn restarted without a new user message (an answered ``ask_user``)
   * and has produced nothing yet — show the "about to respond" dots, which
   * neither of the other two conditions can detect.
   */
  isAwaitingRestart?: boolean
  /** True when the agent is in error state. */
  isError?: boolean
  /** Error message to display when isError is true. */
  lastError?: string | null
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
            toolCallId={block.toolCallId}
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

export function AgentView({ blocks, currentBlocks, isWorking, isTurnOpen = isWorking, isAwaitingRestart = false, isError, lastError, onContinue, emptyState, onMentionFileOpen }: AgentViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // attachedRef: true = follow the stream.
  //   → true:  user sends a message, clicks the button, or scrolls to the bottom
  //   → false: user scrolls up and is no longer at the bottom
  const attachedRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  // Timestamp (ms) until which a user scroll-up gesture (wheel / touch) is
  // considered "in flight" — suppresses the at-bottom re-attach so small
  // trackpad deltas can escape the auto-follow snap during streaming.
  const userScrollIntentUntilRef = useRef(0)
  // True while a pointer is held inside the transcript — a scrollbar drag or a
  // text selection. Neither produces wheel/touch events, so auto-follow must
  // stand down for the duration or it fights the gesture every time output
  // arrives (twice a second for a streaming shell command).
  const pointerDownRef = useRef(false)
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
  const latestUserBlockId = useMemo(
    () => latestDirectUserBlockIdFromParts(blocks, currentBlocks),
    [blocks, currentBlocks],
  )
  const finalizedTurnItems = useMemo(() => partitionTurns(blocks), [blocks])
  const turnItems = useMemo(
    () => appendCurrentTurns(finalizedTurnItems, blocks.length, currentBlocks),
    [blocks.length, currentBlocks, finalizedTurnItems],
  )
  const { hiddenTurnCount, visibleTurnItems } = useMemo(
    () => getVisibleTurnWindow(turnItems, renderedTurnCount),
    [renderedTurnCount, turnItems],
  )
  const finalizedMCPAppResources = useMemo(() => latestMCPAppResources(blocks), [blocks])
  const latestMCPAppBlockIds = useMemo(
    () => latestMCPAppResourceBlockIdsFromParts(finalizedMCPAppResources, currentBlocks),
    [currentBlocks, finalizedMCPAppResources],
  )

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
    const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
    attachedRef.current = true
    userScrollIntentUntilRef.current = 0 // explicit attach cancels any gesture
    setShowScrollBtn(false)
    if (behavior === 'smooth' && typeof el.scrollTo === 'function') {
      isProgrammaticScrollRef.current = true
      el.scrollTo({ top: bottom, behavior: 'smooth' })
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        isProgrammaticScrollRef.current = false
        el.removeEventListener('scrollend', finish)
        // WKWebView (macOS desktop + iOS) can silently no-op a smooth
        // scrollTo (see AGENTS.md). Recompute the bottom — the stream may
        // have grown during the animation — and jump instantly if the view
        // did not actually get there, so the button always lands the user
        // at the stream tail.
        const target = Math.max(0, el.scrollHeight - el.clientHeight)
        if (Math.abs(el.scrollTop - target) > 1) {
          el.scrollTop = target
          lastScrollTopRef.current = el.scrollTop
        }
      }
      el.addEventListener('scrollend', finish)
      setTimeout(finish, 500)
    } else {
      el.scrollTop = bottom
      lastScrollTopRef.current = el.scrollTop
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
        // Don't re-attach while a user scroll-up gesture is in flight — small
        // wheel/trackpad deltas land within SCROLL_THRESHOLD (or the
        // auto-follow already snapped the view back) and re-attaching here
        // would let the ResizeObserver eat the gesture.
        if (Date.now() >= userScrollIntentUntilRef.current) {
          attachedRef.current = true
          setShowScrollBtn(false)
        }
      } else if (attachedRef.current) {
        // Don't detach when the virtual keyboard opened (viewport shrink, not user scroll),
        // but keep processing the event so scroll-to-top pagination still works.
        if (!document.documentElement.hasAttribute('data-keyboard-open')) {
          // We only detach if the user scrolled UP (meaning scrollTop decreased).
          // If scrollTop increased or stayed the same, it could be due to layout/ResizeObserver/smooth scroll
          // and we want to remain attached.
          const isScrollUp = currentScrollTop < prevScrollTop
          if (isScrollUp) {
            attachedRef.current = false
            setShowScrollBtn(true)
          }
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

    // Detach on direct user input. During heavy stream growth (e.g. a shell
    // tool result flushing a large block) the auto-follow ResizeObserver
    // rewrites scrollTop to the bottom before the scroll listener runs, so
    // onScroll never observes the upward movement — wheel/touch events are
    // the only reliable signal of the user's intent to scroll up.
    const detachForUserScrollUp = () => {
      userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS
      if (!attachedRef.current) return
      if (el.scrollHeight - el.clientHeight <= 1) return // nothing to scroll
      attachedRef.current = false
      setShowScrollBtn(true)
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) detachForUserScrollUp()
    }
    let lastTouchY: number | null = null
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (y === undefined) return
      // Finger moving down the screen scrolls the content up.
      if (lastTouchY !== null && y > lastTouchY) detachForUserScrollUp()
      lastTouchY = y
    }

    // Keyboard scrolling (PageUp / Home / arrows) moves the viewport without a
    // wheel or touch event, so it needs its own detach — otherwise the next
    // ResizeObserver tick drags the user straight back to the bottom.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCROLL_UP_KEYS.has(e.key)) return
      const target = e.target as HTMLElement | null
      // Only keys aimed at the transcript scroll it. A menu, dialog or model
      // picker moving its own selection with the arrows is navigating itself;
      // `body` is the target when nothing holds focus, which is the case the
      // browser actually scrolls.
      if (target && target !== document.body && !el.contains(target)) return
      // Caret movement inside the composer is not transcript scrolling.
      if (target && (target.isContentEditable || EDITABLE_TAGS.has(target.tagName))) return
      detachForUserScrollUp()
    }

    // Pointer held down: scrollbar drag or selection drag. The RO consults
    // this and stops snapping; on release we re-pin only if the gesture left
    // us attached (i.e. the user never actually scrolled away).
    const onPointerDown = () => { pointerDownRef.current = true }
    const onPointerUp = () => {
      if (!pointerDownRef.current) return
      pointerDownRef.current = false
      if (!attachedRef.current) return
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      lastScrollTopRef.current = el.scrollTop
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', onPointerUp, { passive: true })
    document.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.removeEventListener('keydown', onKeyDown)
    }
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

  // Me re-attach on session switch. A detach is a statement about *this*
  // conversation; carrying it into the next one left newly opened sessions
  // sitting mid-transcript and not following their live stream.
  useEffect(() => {
    pendingRestoreRef.current = false
    prevScrollHeightRef.current = null
    attachedRef.current = true
    setShowScrollBtn(false)
    scrollToBottom()
  }, [sessionId, scrollToBottom])

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

  // ResizeObserver: when attached and content grows, keep the stream pinned to
  // the bottom. Skip scrollport-height changes while the keyboard is open — on
  // mobile those fire every frame during manual chat scrolling, and forcing
  // scrollTop there fights the user's gesture and flickers the scrollbar.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    let lastContentHeight = content.getBoundingClientRect().height
    let lastClientHeight = el.clientHeight
    const ro = new ResizeObserver((entries) => {
      if (!attachedRef.current) return
      // Mid-gesture (scrollbar drag, selection drag): leave the scroll
      // position alone. `onPointerUp` re-pins if the user stayed attached.
      if (pointerDownRef.current) return
      const nextContentHeight = content.getBoundingClientRect().height
      const nextClientHeight = el.clientHeight
      const contentGrew = nextContentHeight > lastContentHeight
      const viewportChanged = nextClientHeight !== lastClientHeight
      const contentChanged = entries.some((entry) => entry.target === content)
      lastContentHeight = nextContentHeight
      lastClientHeight = nextClientHeight
      if (document.documentElement.hasAttribute('data-keyboard-open') && viewportChanged && !contentGrew && !contentChanged) return
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      lastScrollTopRef.current = el.scrollTop
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
                         latestMCPAppBlockIds={mcpAppResourceUri(item.block) ? latestMCPAppBlockIds : undefined}
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
                     isTurnOpen={isTurnOpen}
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
                            latestMCPAppBlockIds={mcpAppResourceUri(block) ? latestMCPAppBlockIds : undefined}
                         onMentionFileOpen={onMentionFileOpen}
                          />
                     )}
                   />
                 )
                })}

            {/* Me show dots when:
             *   1. pending - user just sent, agent hasn't woken yet (no agent_status event yet), OR
             *   2. working with no visible agent content yet (user bubbles don't count), OR
             *   3. restarting after an answered question - no new user block, and
             *      currentBlocks still holds the turn being resumed, so neither
             *      of the above can see it.
             * Covers the POST to first SSE event gap so the user always gets immediate feedback.
             */}
            {((!isTurnOpen && !isError && currentBlocks.some(isDirectUserBlock)) ||
              isAwaitingRestart ||
              (isWorking && currentBlocks.every((b) => b.type === 'user' || isBlankContentBlock(b)))) && (
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
