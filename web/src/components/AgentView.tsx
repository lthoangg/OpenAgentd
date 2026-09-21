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

import { useState, useRef, useEffect, useCallback, useMemo, memo, lazy, Suspense } from 'react'
import OctobotMascot from '@/assets/brand/octobot-agentd-source.png'

import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { ChevronDown, ChevronUp, AlertCircle, Clock } from 'lucide-react'
import { Thinking } from './Thinking'
import { ToolCall } from './ToolCall'
const MCPAppResult = lazy(() => import('./MCPAppResult').then((module) => ({ default: module.MCPAppResult })))
import { CompactionDivider } from './CompactionDivider'
import { AssistantTurn } from './AssistantTurnFooter'
import { PendingMessageQueue } from './PendingMessageQueue'
import { appendCurrentTurns, getVisibleTurnWindow, partitionTurns } from '@/utils/turns'
import { hasPlanContent, latestDirectUserBlockIdFromParts, liveBlockTail } from '@/utils/blocks'
import { extractSleepPrefix } from '@/utils/format'
import { latestMCPAppResourceBlockIdsFromParts, latestMCPAppResources, mcpAppResourceUri } from '@/utils/mcp-app-artifacts'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'
import { UserBubble } from './AgentView/UserBubble'
import { EmptyState } from '@/components/ui/empty-state'
import { useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'
import { TranscriptFind } from './AgentView/TranscriptFind'
import { collectTranscriptFindMatches, isTranscriptFindableBlock } from './AgentView/transcript-find'
import { applyTranscriptFindHighlight, clearTranscriptFindHighlight } from './AgentView/transcript-find-highlight'

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

interface QuotaWait {
  model?: string
  message?: string
  resetsAt?: number
}

const QUOTA_WAIT_STORAGE_PREFIX = 'openagentd:quota-wait:'

function quotaWaitStorageKey(sessionId: string): string {
  return `${QUOTA_WAIT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
}

function readStoredQuotaWait(sessionId: string | undefined): QuotaWait | null {
  if (!sessionId || typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(quotaWaitStorageKey(sessionId))
    if (!raw) return null
    const stored = JSON.parse(raw) as { model?: unknown; resetsAt?: unknown }
    if (typeof stored.resetsAt !== 'number' || !Number.isFinite(stored.resetsAt)) return null
    if (stored.resetsAt <= Date.now() / 1000) {
      window.localStorage.removeItem(quotaWaitStorageKey(sessionId))
      return null
    }
    return {
      model: typeof stored.model === 'string' ? stored.model : undefined,
      resetsAt: stored.resetsAt,
    }
  } catch {
    return null
  }
}

function saveQuotaWait(sessionId: string | undefined, wait: QuotaWait): void {
  if (!sessionId || wait.resetsAt === undefined || typeof window === 'undefined') return

  try {
    window.localStorage.setItem(
      quotaWaitStorageKey(sessionId),
      JSON.stringify({ model: wait.model, resetsAt: wait.resetsAt }),
    )
  } catch {
    // Storage can be unavailable in private browsing or when disabled.
  }
}

function removeStoredQuotaWait(sessionId: string | undefined): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(quotaWaitStorageKey(sessionId))
  } catch {
    // Storage can be unavailable in private browsing or when disabled.
  }
}

function quotaWaitFromBlock(block: ContentBlock): QuotaWait | null {
  if (block.type !== 'provider_status' || block.extra?.status !== 'waiting_quota') return null

  const model = typeof block.extra.model === 'string' ? block.extra.model : undefined
  const resetsAt = typeof block.extra.resets_at === 'number' && Number.isFinite(block.extra.resets_at)
    ? block.extra.resets_at
    : typeof block.extra.retry_after === 'number' && Number.isFinite(block.extra.retry_after)
    ? Date.now() / 1000 + block.extra.retry_after
    : undefined
  return {
    model,
    message: typeof block.extra.message === 'string' ? block.extra.message : undefined,
    resetsAt,
  }
}

function latestQuotaWait(blocks: ContentBlock[]): QuotaWait | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const wait = quotaWaitFromBlock(blocks[index])
    if (wait) return wait
  }
  return null
}

function formatQuotaCountdown(resetsAt: number, now = Date.now()): string {
  const remainingSeconds = resetsAt - now / 1000
  if (remainingSeconds <= 0) return 'Resetting now'

  const totalMinutes = Math.ceil(remainingSeconds / 60)
  if (totalMinutes < 1) return 'Resets in <1m'

  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `Resets in ${days}d ${String(hours).padStart(2, '0')}h`
  if (hours > 0) return `Resets in ${hours}h ${String(minutes).padStart(2, '0')}m`
  return `Resets in ${minutes}m`
}

function QuotaWaitNotice({ wait, sessionId, persist }: { wait: QuotaWait; sessionId?: string; persist: boolean }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (persist) saveQuotaWait(sessionId, { model: wait.model, resetsAt: wait.resetsAt })
  }, [persist, sessionId, wait.model, wait.resetsAt])

  useEffect(() => {
    if (wait.resetsAt !== undefined && now >= wait.resetsAt * 1000) {
      removeStoredQuotaWait(sessionId)
    }
  }, [now, sessionId, wait.resetsAt])

  const countdown = wait.resetsAt === undefined ? null : formatQuotaCountdown(wait.resetsAt, now)
  const model = wait.model ?? 'model'

  return (
    <div className="my-2 rounded-md border border-(--color-warning)/30 bg-(--color-warning-subtle) px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-(--color-warning)">
        <Clock size={14} className="shrink-0 animate-pulse" />
        <span>Quota Limit Reached · Waiting for Reset</span>
        {countdown && <span className="ml-auto shrink-0 font-normal" aria-live="polite">{countdown}</span>}
      </div>
      <p className="mt-1 text-(--color-text-muted) leading-relaxed break-words">
        {wait.message || `Provider quota exhausted for ${model}. Waiting for reset. Agent will automatically resume work. You can stop anytime.`}
      </p>
    </div>
  )
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
  /** Optional slot rendered in place of the default mascot empty state. */
  emptyState?: React.ReactNode
  /** Open a mentioned workspace file in the coding workspace sidebar. */
  onMentionFileOpen?: (path: string) => void
  /** Callback to switch to Code mode and start implementation of a proposed plan. */
  onStartImplementing?: () => void
  /** True when interaction mode is actively transitioning to Code mode. */
  isSwitchingInteractionMode?: boolean
  findOpen?: boolean
  findQuery?: string
  findActiveIndex?: number
  onFindQueryChange?: (query: string) => void
  onFindClose?: () => void
  onFindActiveIndexChange?: (index: number) => void
}

const BlockRenderer = memo(function BlockRenderer({ block, isStreaming, sessionId, onRevert, latestMCPAppBlockIds, onMentionFileOpen }: { block: ContentBlock; isStreaming: boolean; sessionId?: string; onRevert?: () => void; latestMCPAppBlockIds?: Set<string>; onMentionFileOpen?: (path: string) => void }) {
  switch (block.type) {
    case 'user': {
      const blockModel = typeof block.extra?.model === 'string' ? block.extra.model : null
      const fromAgent = typeof block.extra?.from_agent === 'string' ? block.extra.from_agent : null
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} onRevert={onRevert} modelId={blockModel} onMentionFileOpen={onMentionFileOpen} mentions={block.extra?.mentions as string[] | undefined} fromAgent={fromAgent} />
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
      const title = (block.extra?.title as string) || (status === 'error' || status === 'exhausted' ? 'Provider Error' : undefined)
      const customMsg = block.extra?.message as string | undefined

      if (status === 'error' || status === 'exhausted' || block.extra?.category === 'provider') {
        return (
          <div className="my-2 rounded-md border border-(--color-error)/30 bg-(--color-error-subtle) px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-(--color-error)">
              <AlertCircle size={14} className="shrink-0" />
              <span>{title || 'Provider Error'}</span>
            </div>
            <p className="mt-1 text-(--color-error)/90 leading-relaxed break-words">{customMsg || block.content}</p>
          </div>
        )
      }

      if (status === 'waiting_quota') {
        const wait = quotaWaitFromBlock(block)
        return wait ? <QuotaWaitNotice wait={wait} sessionId={sessionId} persist /> : null
      }

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
              <Suspense fallback={<p role="status" className="min-h-24 text-xs text-(--color-text-muted)">Loading interactive tool result...</p>}>
                <MCPAppResult mcpApp={mcpApp as never} sessionId={sessionId} toolCallId={block.toolCallId} />
              </Suspense>
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

export function AgentView({
  blocks,
  currentBlocks,
  isWorking,
  isTurnOpen = isWorking,
  isAwaitingRestart = false,
  isError,
  lastError,
  emptyState,
  onMentionFileOpen,
  onStartImplementing,
  isSwitchingInteractionMode = false,
  findOpen = false,
  findQuery = '',
  findActiveIndex = 0,
  onFindQueryChange,
  onFindClose,
  onFindActiveIndexChange,
}: AgentViewProps) {
  const [renderedTurnCount, setRenderedTurnCount] = useState(INITIAL_RENDERED_TURNS)
  const sessionId = useAgentStore((s) => s.sessionId) ?? undefined
  const sessionInteractionMode = useAgentStore((s) => s.sessionInteractionMode)
  const prevScrollHeightRef = useRef<number | null>(null)
  const loadingOlderRef = useRef(false)
  const hiddenTurnCountRef = useRef(0)
  const showEarlierTurnsRef = useRef<() => void>(() => {})
  const pendingRestoreRef = useRef(false)
  const onLoadOlderTopRef = useRef<() => void>(() => {})

  const handleRevert = useCallback(() => {
    void useAgentStore.getState().undoAgent().then(async (response) => {
      const message = response?.message
      if (!message || message.role !== 'user' || message.is_summary) return
      window.dispatchEvent(
        new CustomEvent('undo:restore-draft', {
          detail: { content: message.content ?? '', attachments: message.attachments ?? [] },
        }),
      )
    })
  }, [])

  // Live blocks not yet folded into `blocks`, deduped against confirmed ids.
  // Both scroll bookkeeping and turn partitioning below read from this same
  // array, so they can never disagree about what actually renders (a merged
  // `[...blocks, ...liveTail]` copy is never needed here — nothing reads full
  // merged content, only counts and the last block).
  const liveTail = useMemo(() => liveBlockTail(blocks, currentBlocks), [blocks, currentBlocks])
  const searchableBlocks = useMemo(() => [...blocks, ...liveTail], [blocks, liveTail])
  const findMatches = useMemo(
    () => (findOpen ? collectTranscriptFindMatches(searchableBlocks, findQuery) : []),
    [findOpen, findQuery, searchableBlocks],
  )
  const clampedFindIndex = findMatches.length === 0
    ? 0
    : ((findActiveIndex % findMatches.length) + findMatches.length) % findMatches.length
  const totalLen = blocks.length + liveTail.length
  const latestUserBlockId = useMemo(
    () => latestDirectUserBlockIdFromParts(blocks, currentBlocks),
    [blocks, currentBlocks],
  )
  const finalizedTurnItems = useMemo(() => partitionTurns(blocks), [blocks])
  const turnItems = useMemo(
    () => appendCurrentTurns(finalizedTurnItems, blocks.length, liveTail),
    [blocks.length, liveTail, finalizedTurnItems],
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
  const liveQuotaWait = useMemo(
    () => latestQuotaWait([...blocks, ...liveTail]),
    [blocks, liveTail],
  )
  const storedQuotaWait = useMemo(() => readStoredQuotaWait(sessionId), [sessionId])

  const restoredQuotaWait = liveQuotaWait ? null : storedQuotaWait
  const visibleQuotaWait = liveQuotaWait ?? restoredQuotaWait

  const lastBlock = liveTail.length > 0 ? liveTail[liveTail.length - 1] : blocks[blocks.length - 1]
  const lastContent = lastBlock
    ? `${lastBlock.content ?? ''}:${lastBlock.toolOutput ?? ''}:${lastBlock.toolResult ?? ''}:${lastBlock.toolArgs ?? ''}`
    : ''
  const isUserMessage = lastBlock ? isDirectUserBlock(lastBlock) : false
  const isEmpty = !isWorking &&
    !blocks.some((b) => b.type !== 'compaction') &&
    !liveTail.some((b) => b.type !== 'compaction') &&
    !visibleQuotaWait

  const handleLoadOlderTopTrigger = useCallback(() => {
    onLoadOlderTopRef.current()
  }, [])

  const {
    scrollRef,
    contentRef,
    anchorRef,
    attachedRef,
    showScrollBtn,
    scrollToBottom,
  } = useAutoFollowScroll({
    totalLen,
    lastContent,
    sessionId,
    isUserMessage,
    isEmpty,
    onLoadOlderTop: handleLoadOlderTopTrigger,
  })

  const showEarlierTurns = useCallback(() => {
    const el = scrollRef.current
    if (el) {
      prevScrollHeightRef.current = el.scrollHeight
      pendingRestoreRef.current = true
    }
    setRenderedTurnCount((count) => Math.min(turnItems.length, count + TURN_RENDER_STEP))
  }, [scrollRef, turnItems.length])

  const handleLoadOlderTop = useCallback(() => {
    if (hiddenTurnCountRef.current > 0) {
      showEarlierTurns()
    } else if (useAgentStore.getState().hasMore && !loadingOlderRef.current) {
      loadingOlderRef.current = true
      const el = scrollRef.current
      if (el) prevScrollHeightRef.current = el.scrollHeight
      pendingRestoreRef.current = true
      void useAgentStore.getState().loadOlderMessages().finally(() => {
        loadingOlderRef.current = false
      })
    }
  }, [scrollRef, showEarlierTurns])

  // Keep the refs in sync so callbacks/listeners always see
  // the latest values without needing to re-register listeners.
  useEffect(() => {
    onLoadOlderTopRef.current = handleLoadOlderTop
    hiddenTurnCountRef.current = hiddenTurnCount
    showEarlierTurnsRef.current = showEarlierTurns
  })

  // Restore scroll position after older messages are prepended.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pendingRestoreRef.current || prevScrollHeightRef.current === null) return
    pendingRestoreRef.current = false
    attachedRef.current = false
    el.scrollTop = el.scrollHeight - prevScrollHeightRef.current
    prevScrollHeightRef.current = null
  }, [blocks.length, renderedTurnCount, scrollRef, attachedRef])

  const cycleFind = useCallback((delta: number) => {
    if (findMatches.length === 0) return
    const next = ((clampedFindIndex + delta) % findMatches.length + findMatches.length) % findMatches.length
    onFindActiveIndexChange?.(next)
  }, [clampedFindIndex, findMatches.length, onFindActiveIndexChange])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    if (!findOpen) {
      clearTranscriptFindHighlight(root)
      return
    }
    let observer: MutationObserver | null = null
    const paint = (scrollActive: boolean) => {
      observer?.disconnect()
      const active = applyTranscriptFindHighlight(root, findQuery, clampedFindIndex)
      if (scrollActive && active) {
        attachedRef.current = false
        active.scrollIntoView({ block: 'center' })
      }
      observer?.observe(root, { subtree: true, childList: true, characterData: true })
    }
    observer = new MutationObserver(() => paint(false))
    paint(true)
    return () => {
      observer?.disconnect()
      clearTranscriptFindHighlight(root)
    }
  }, [attachedRef, clampedFindIndex, findOpen, findQuery, scrollRef])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    {findOpen && (
      <TranscriptFind
        query={findQuery}
        matchCount={findMatches.length}
        activeIndex={clampedFindIndex}
        onQueryChange={(next) => onFindQueryChange?.(next)}
        onNext={() => cycleFind(1)}
        onPrev={() => cycleFind(-1)}
        onClose={() => onFindClose?.()}
      />
    )}
    <div ref={scrollRef} className="oa-chat-scroll flex-1 overflow-y-auto">
      <div ref={contentRef} className="mx-auto max-w-3xl px-3 py-5 sm:px-4 sm:py-6">
        {isEmpty && (
           emptyState ?? (
             // Same weight as every other blank state (see `EmptyState`); the
             // mascot rides in the chip instead of as a 4xl hero.
             <EmptyState
               fill={false}
               className="py-16 select-none"
               icon={
                 <img
                   src={OctobotMascot}
                   className="opacity-90"
                   width={28}
                   height={28}
                   alt=""
                   aria-hidden="true"
                 />
               }
               title={'what\u2019s on your mind?'}
             />
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
                     <div
                       key={item.block.id}
                       data-find-block={isTranscriptFindableBlock(item.block.type) ? item.block.id : undefined}
                     >
                       <BlockRenderer
                         block={item.block}
                         isStreaming={false}
                         sessionId={sessionId}
                         onRevert={item.block.id === latestUserBlockId ? handleRevert : undefined}
                         latestMCPAppBlockIds={mcpAppResourceUri(item.block) ? latestMCPAppBlockIds : undefined}
                         onMentionFileOpen={onMentionFileOpen}
                       />
                     </div>
                   )
                 }
                 // Me only the trailing turn (no user block after) can be "live"
                  const isTrailingTurn = globalTurnIndex === turnItems.length - 1
                  const canStartImplementing =
                    isTrailingTurn &&
                    !isWorking &&
                    sessionInteractionMode === 'plan' &&
                    hasPlanContent(item.blocks)
                 return (
                   <AssistantTurn
                     key={`turn-${item.startIndex}-${item.blocks[0]?.id ?? k}`}
                     blocks={item.blocks}
                     startIndex={item.startIndex}
                     finalizedCount={blocks.length}
                     isWorking={isWorking}
                     isTurnOpen={isTurnOpen}
                     isTrailingTurn={isTrailingTurn}
                      totalBlocks={totalLen}
                      size="roomy"
                      onStartImplementing={canStartImplementing ? onStartImplementing : undefined}
                     isSwitchingInteractionMode={isSwitchingInteractionMode}
                      renderBlock={({ block, isStreaming }) => (
                       <div
                         data-find-block={isTranscriptFindableBlock(block.type) ? block.id : undefined}
                       >
                         <BlockRenderer
                           block={block}
                           isStreaming={isStreaming}
                           sessionId={sessionId}
                           onRevert={isDirectUserBlock(block) && block.id === latestUserBlockId ? handleRevert : undefined}
                           latestMCPAppBlockIds={mcpAppResourceUri(block) ? latestMCPAppBlockIds : undefined}
                           onMentionFileOpen={onMentionFileOpen}
                         />
                       </div>
                     )}
                   />
                 )
                })}

            {restoredQuotaWait && (
              <QuotaWaitNotice wait={restoredQuotaWait} sessionId={sessionId} persist={false} />
            )}

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

           <div ref={anchorRef} data-chat-scroll-anchor aria-hidden="true" />
         </div>
      </div>
    </div>
    {showScrollBtn && (
        <button
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-16 left-1/2 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) active:scale-90 motion-reduce:active:scale-100"
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={14} />
        </button>

    )}
    </div>
  )
}
