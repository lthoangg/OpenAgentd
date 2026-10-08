/**
 * AgentView — single-agent full-width view (viewMode === 'agent').
 *
 * Renders a flat ContentBlock[] stream (finalized + live) with:
 * - type:'user'    → yellow user bubble
 * - type:'thinking' → inline thinking trace
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

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useDeferredValue, useMemo, memo } from 'react'
import OctobotMascot from '@/assets/brand/octobot-agentd-source.png'

import { MarkdownBlock } from '@/utils/markdown'
import { ChevronDown, ChevronUp, Clock } from 'lucide-react'
import { Thinking } from './Thinking'
import { ToolCall } from './ToolCall'
import { MCPAppResult } from './MCPAppResult'
import { TimelineScrubber } from './AgentView/TimelineScrubber'
import { CompactionDivider } from './CompactionDivider'
import { AssistantTurn, type AssistantTurnProps } from './AssistantTurnFooter'
import { PendingMessageQueue } from './PendingMessageQueue'
import { appendCurrentTurns, getVisibleTurnWindow, partitionTurns, promptModels } from '@/utils/turns'
import { countBlocksAfter, liveBlockTail } from '@/utils/blocks'
import { extractSleepPrefix } from '@/utils/format'
import { latestMCPAppResourceBlockIdsFromParts, latestMCPAppResources, mcpAppResourceUri } from '@/utils/mcp-app-artifacts'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { appShortcut, useShortcuts } from '@/lib/keyboard/hooks'
import type { ContentBlock } from '@/api/types'
import { UserBubble, type OpenSessionHandler } from './AgentView/UserBubble'
import { replyFrom, sentFrom } from '@/utils/workspace-messages'
import { ErrorCard } from './AgentView/ErrorCard'
import { isDirectUserBlock, PROMPT_JUMP_MARGIN, previousPromptTurn, promptElements, promptJumpTarget, turnIndexOfBlock } from './AgentView/prompt-nav'
import { FileRefContext, type FileRefOpener } from './FileRefLink'
import { copyText, useChatMenu } from './ChatContextMenu'
import { EmptyState } from '@/components/ui/empty-state'
import { useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'
import { TranscriptFind } from './AgentView/TranscriptFind'
import { collectTranscriptFindMatches, isTranscriptFindableBlock } from './AgentView/transcript-find'
import { clearTranscriptFind, paintTranscriptFind } from './AgentView/transcript-find-highlight'

const INITIAL_RENDERED_TURNS = 80
const TURN_RENDER_STEP = 80
/** Older pages a reload may fetch on its own to reach a prompt (100 rows each). */
const AUTO_PROMPT_SEEK_PAGES = 2
/** How long a prompt jump is treated as still in flight. */
const PROMPT_JUMP_MS = 700

/**
 * Earlier turns on their way in above the view, revealed or loaded. The view
 * holds still by the first rendered block's top in content px until every
 * reveal or load that asked for them has settled. There is one hold, shared,
 * since two would each add the height that landed.
 */
interface ViewHold {
  sessionId: string | undefined
  anchorId: string | null
  anchorTop: number
  /** Reveals and loads still settling. */
  pending: number
}

/** A prompt jump waiting on a hold for the turns it needs to render or load. */
interface PendingPromptJump {
  /** The block to land on; ``null`` for the nearest prompt above the first rendered turn (⌥⌘↑). */
  targetId: string | null
  /** Jump once the prompt renders; scrolling by hand or ↓ clears it. */
  jump: boolean
}

/** ``el``'s top in the scroller's content, which scrolling does not change. */
function contentTop(root: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
}

function blockElement(root: HTMLElement, id: string): HTMLElement | undefined {
  // Block ids are uuids/hex, safe inside a quoted attribute selector; anything
  // else takes the scan instead of needing CSS.escape.
  if (/^[\w-]+$/.test(id)) return root.querySelector<HTMLElement>(`[data-block-id="${id}"]`) ?? undefined
  return Array.from(root.querySelectorAll<HTMLElement>('[data-block-id]')).find((el) => el.dataset.blockId === id)
}

function isProviderErrorBlock(block: ContentBlock): boolean {
  if (block.type !== 'provider_status') return false
  const status = block.extra?.status
  return status === 'error' || status === 'exhausted' || block.extra?.category === 'provider'
}

/** The provider error a turn ended on, if it ended on one. */
function endingProviderError(blocks: ContentBlock[]): ContentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isBlankContentBlock(blocks[i])) continue
    return isProviderErrorBlock(blocks[i]) ? blocks[i] : undefined
  }
  return undefined
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

/**
 * Bring a find match to the middle of the transcript. A range has no
 * ``scrollIntoView``: its element is brought into view first, so a match in a
 * horizontally scrolled code block is revealed, then the match itself is
 * centred (the element can be far taller than the viewport).
 */
function scrollRangeToCenter(root: HTMLElement, range: Range) {
  range.startContainer.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const rect = range.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  root.scrollTop += rect.top + rect.height / 2 - (rootRect.top + root.clientHeight / 2)
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
  /** Open a mentioned workspace file in the file viewer. */
  onMentionFileOpen?: (path: string) => void
  /** Open another session (the other end of a workspace message). */
  onOpenSession?: OpenSessionHandler
  /** Opens ``path:line`` references in replies and tool output. */
  fileRefOpener?: FileRefOpener
  /** Resend the latest prompt; offered under the latest finished answer. */
  onRetry?: () => void
  /** Pick another model; offered with Retry on the error a turn ended with. */
  onSwitchModel?: () => void
  findOpen?: boolean
  findQuery?: string
  findActiveIndex?: number
  onFindQueryChange?: (query: string) => void
  onFindClose?: () => void
  onFindActiveIndexChange?: (index: number) => void
  /**
   * The floating composer carries the jump-to-latest chip, so the transcript
   * publishes its follow state instead of drawing its own button.
   */
  jumpToLatestInComposer?: boolean
}

const BlockRenderer = memo(function BlockRenderer({ block, isStreaming, sessionId, onEdit, promptModel, promptThinkingLevel, onRetry, onSwitchModel, latestMCPAppBlockIds, onMentionFileOpen, onOpenSession }: {
  block: ContentBlock
  isStreaming: boolean
  sessionId?: string
  /** Rewind to a prompt the user wrote; ignored for agent reports. */
  onEdit?: (blockId: string) => void
  /** The model and thinking level a prompt ran with; strings so memo holds while streaming. */
  promptModel?: string
  promptThinkingLevel?: string
  /** Error actions; the caller passes them to the error a turn ended with only. */
  onRetry?: () => void
  onSwitchModel?: () => void
  latestMCPAppBlockIds?: Set<string>
  onMentionFileOpen?: (path: string) => void
  onOpenSession?: OpenSessionHandler
}) {
  switch (block.type) {
    case 'user': {
      const fromAgent = typeof block.extra?.from_agent === 'string' ? block.extra.from_agent : null
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} onEdit={onEdit && !fromAgent ? () => onEdit(block.id) : undefined} modelId={promptModel} thinkingLevel={promptThinkingLevel} onMentionFileOpen={onMentionFileOpen} mentions={block.extra?.mentions as string[] | undefined} fromAgent={fromAgent} sentFrom={sentFrom(block.extra)} replyFrom={replyFrom(block.extra)} onOpenSession={onOpenSession} />
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
      const customMsg = block.extra?.message as string | undefined

      if (isProviderErrorBlock(block)) {
        return (
          <ErrorCard
            title={(block.extra?.title as string) || 'Provider Error'}
            message={customMsg || block.content}
            onRetry={onRetry}
            onSwitchModel={onSwitchModel}
          />
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
        // Dropped connections retry without a budget until the network is back.
        const progress = typeof maxAttempts === 'number'
          ? `${String(attempt ?? '?')}/${maxAttempts}`
          : `attempt ${String(attempt ?? '?')}`
        message = `Retrying ${String(model ?? 'model')} (${progress})${errorText}.${delayText}`
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
            {sleepPrefix && <MarkdownBlock content={sleepPrefix} sessionId={sessionId} />}
            <p className="text-xs text-(--color-text-subtle) italic">— idle —</p>
          </div>
        )
      }
      return (
        <AssistantText content={block.content} sessionId={sessionId} isStreaming={isStreaming} />
      )
    }
    default:
      return null
  }
})

/** An assistant message, with Copy response / Copy as Markdown on its menu. */
function AssistantText({ content, sessionId, isStreaming }: { content: string; sessionId?: string; isStreaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const chatMenu = useChatMenu('Actions for response', () => [
    // As rendered: no Markdown syntax.
    { label: 'Copy response', run: () => copyText((ref.current?.innerText || ref.current?.textContent || content).trim()) },
    { label: 'Copy as Markdown', run: () => copyText(content) },
  ])
  return (
    <div ref={ref} onContextMenu={chatMenu.onContextMenu} onKeyDown={chatMenu.onKeyDown}>
      <MarkdownBlock content={content} sessionId={sessionId} isStreaming={isStreaming} />
      {chatMenu.menu}
    </div>
  )
}

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
  onOpenSession,
  fileRefOpener,
  onRetry,
  onSwitchModel,
  findOpen = false,
  findQuery = '',
  findActiveIndex = 0,
  onFindQueryChange,
  onFindClose,
  onFindActiveIndexChange,
  jumpToLatestInComposer = false,
}: AgentViewProps) {
  const [renderedTurnCount, setRenderedTurnCount] = useState(INITIAL_RENDERED_TURNS)
  const sessionId = useAgentStore((s) => s.sessionId) ?? undefined
  const loadingOlderRef = useRef(false)
  const hiddenTurnCountRef = useRef(0)
  const showEarlierTurnsRef = useRef<() => void>(() => {})
  const onLoadOlderTopRef = useRef<() => void>(() => {})

  // The store puts the prompt back in the composer via ``pendingDraft``.
  const handleEdit = useCallback((blockId: string) => {
    void useAgentStore.getState().revertToMessage(blockId)
  }, [])
  const editHandler = isTurnOpen ? undefined : handleEdit

  // Live blocks not yet folded into `blocks`, deduped against confirmed ids.
  // Both scroll bookkeeping and turn partitioning below read from this same
  // array, so they can never disagree about what actually renders (a merged
  // `[...blocks, ...liveTail]` copy is never needed here — nothing reads full
  // merged content, only counts and the last block).
  const liveTail = useMemo(() => liveBlockTail(blocks, currentBlocks), [blocks, currentBlocks])
  // Matching walks the whole transcript, so it trails the keystroke that asked
  // for it: the find field updates at once, the matches when React has time.
  const deferredFindQuery = useDeferredValue(findQuery)
  // Merged only while find is open: the copy costs a whole-transcript walk
  // on every streamed token.
  const findMatches = useMemo(
    () => (findOpen ? collectTranscriptFindMatches([...blocks, ...liveTail], deferredFindQuery) : []),
    [blocks, deferredFindQuery, findOpen, liveTail],
  )
  const clampedFindIndex = findMatches.length === 0
    ? 0
    : ((findActiveIndex % findMatches.length) + findMatches.length) % findMatches.length
  const findHitBlockIds = useMemo(() => new Set(findMatches.map((match) => match.blockId)), [findMatches])
  const readerTranscript = useDisplayPrefsStore((s) => s.transcriptStyle === 'reader')
  const findBlockIds = useMemo(() => [...findHitBlockIds], [findHitBlockIds])
  const activeFindBlockId = findMatches[clampedFindIndex]?.blockId ?? null
  const totalLen = blocks.length + liveTail.length
  // Reader mode folds a subagent's report into the turn it arrived in.
  const finalizedTurnItems = useMemo(() => partitionTurns(blocks, { foldAgentReports: readerTranscript }), [blocks, readerTranscript])
  const turnItems = useMemo(
    () => appendCurrentTurns(finalizedTurnItems, blocks.length, liveTail, { foldAgentReports: readerTranscript }),
    [blocks.length, liveTail, finalizedTurnItems, readerTranscript],
  )
  const promptModelById = useMemo(() => promptModels(turnItems), [turnItems])
  // Retry rewinds the latest prompt, so it is only honest when nothing but
  // that prompt's own answer, if any, follows a prompt the user wrote.
  const lastTurnItem = turnItems[turnItems.length - 1]
  const promptBeforeLastTurn = turnItems[turnItems.length - 2]
  const latestPrompt = lastTurnItem?.kind === 'user' ? lastTurnItem
    : lastTurnItem?.kind === 'assistant' && promptBeforeLastTurn?.kind === 'user' ? promptBeforeLastTurn
    : undefined
  // A report folded into the answer (reader mode) follows the prompt too.
  const answerHoldsReport = lastTurnItem?.kind === 'assistant' && lastTurnItem.blocks.some((b) => b.type === 'user')
  const canRetry = Boolean(onRetry) && !isTurnOpen && latestPrompt !== undefined && isDirectUserBlock(latestPrompt.block) && !answerHoldsReport
  // A failed turn offers its way forward on the failure itself: the card for
  // a failure the transcript does not show, else the error the turn ended on.
  const trailingBlocks = lastTurnItem?.kind === 'assistant' ? lastTurnItem.blocks : []
  const showsLastError = Boolean(isError && lastError) && !trailingBlocks.some(
    (b) => isProviderErrorBlock(b) && (b.extra?.message === lastError || b.content === lastError),
  )
  const endingErrorId = isTurnOpen || showsLastError ? undefined : endingProviderError(trailingBlocks)?.id
  const errorRetry = canRetry ? onRetry : undefined
  const errorSwitchModel = isTurnOpen ? undefined : onSwitchModel
  const { hiddenTurnCount, visibleTurnItems } = useMemo(
    () => getVisibleTurnWindow(turnItems, renderedTurnCount),
    [renderedTurnCount, turnItems],
  )
  // A reload shows only the newest page of history. When one long agent run
  // fills it, no prompt is loaded at all, and reader mode folds the run into
  // a short view that may not scroll, so nothing ever asks for older pages.
  // Fetch back to the nearest prompt once per session so the run shows what
  // it answers. The detailed transcript renders that run in full, so it
  // scrolls and loads older pages on its own. The seek is capped well below
  // the manual jump's budget: every page it lands renders at once, as one
  // turn, before the reader asked for any of it.
  const hasMoreHistory = useAgentStore((s) => s.hasMore)
  const hasLoadedPrompt = useMemo(
    () => turnItems.some((item) => item.kind === 'user' && isDirectUserBlock(item.block)),
    [turnItems],
  )
  const promptSeekedForRef = useRef<string | null>(null)
  const hasTurns = turnItems.length > 0
  useEffect(() => {
    if (!readerTranscript || !hasMoreHistory || hasLoadedPrompt || !hasTurns) return
    const state = useAgentStore.getState()
    // A page already on its way lands new turns, which runs this again.
    if (state._loadingOlder || promptSeekedForRef.current === (sessionId ?? '')) return
    promptSeekedForRef.current = sessionId ?? ''
    void state.loadOlderUntilPrompt(AUTO_PROMPT_SEEK_PAGES).catch(() => false)
  }, [hasLoadedPrompt, hasMoreHistory, hasTurns, readerTranscript, sessionId, turnItems])
  const finalizedMCPAppResources = useMemo(() => latestMCPAppResources(blocks), [blocks])
  // Rebuilt per token from the live blocks, but keyed on its contents so the
  // Set (and every renderer holding it) only changes when an app's latest
  // result does. Block ids never contain a newline.
  const latestMCPAppKey = [...latestMCPAppResourceBlockIdsFromParts(finalizedMCPAppResources, currentBlocks)].join('\n')
  const latestMCPAppBlockIds = useMemo(
    () => new Set(latestMCPAppKey ? latestMCPAppKey.split('\n') : []),
    [latestMCPAppKey],
  )
  // One renderer for every turn, so a finished turn's memo holds while the
  // live one streams. Inline in the turns' ``.map`` it was a new closure per
  // turn per render, which the React Compiler cannot cache either.
  const renderTurnBlock = useCallback<AssistantTurnProps['renderBlock']>(({ block, isStreaming }) => (
    <div
      data-block-id={block.id}
      data-find-block={isTranscriptFindableBlock(block.type) ? block.id : undefined}
    >
      <BlockRenderer
        block={block}
        isStreaming={isStreaming}
        sessionId={sessionId}
        onRetry={block.id === endingErrorId ? errorRetry : undefined}
        onSwitchModel={block.id === endingErrorId ? errorSwitchModel : undefined}
        latestMCPAppBlockIds={mcpAppResourceUri(block) ? latestMCPAppBlockIds : undefined}
        onMentionFileOpen={onMentionFileOpen}
        onOpenSession={onOpenSession}
      />
    </div>
  ), [endingErrorId, errorRetry, errorSwitchModel, latestMCPAppBlockIds, onMentionFileOpen, onOpenSession, sessionId])
  // The live tail follows the finalized blocks, so its newest wait wins; only
  // the (small) tail is rescanned per token.
  const finalizedQuotaWait = useMemo(() => latestQuotaWait(blocks), [blocks])
  const liveQuotaWait = useMemo(
    () => latestQuotaWait(liveTail) ?? finalizedQuotaWait,
    [finalizedQuotaWait, liveTail],
  )
  const storedQuotaWait = useMemo(() => readStoredQuotaWait(sessionId), [sessionId])

  const restoredQuotaWait = liveQuotaWait ? null : storedQuotaWait
  const visibleQuotaWait = liveQuotaWait ?? restoredQuotaWait

  const lastBlock = liveTail.length > 0 ? liveTail[liveTail.length - 1] : blocks[blocks.length - 1]
  // A change key for auto-follow, not the content itself: the streamed fields
  // only grow, so their lengths move whenever they do.
  const lastContent = lastBlock
    ? `${lastBlock.id}:${lastBlock.content?.length ?? -1}:${lastBlock.toolOutput?.length ?? -1}:${lastBlock.toolResult?.length ?? -1}:${lastBlock.toolArgs?.length ?? -1}`
    : ''
  const isUserMessage = lastBlock ? isDirectUserBlock(lastBlock) : false
  const isEmpty = !isWorking &&
    !blocks.some((b) => b.type !== 'compaction') &&
    !liveTail.some((b) => b.type !== 'compaction') &&
    !visibleQuotaWait

  // A jump just made; the next press steps on from its target.
  const pendingJumpRef = useRef<{ id: string; until: number } | null>(null)
  const promptJumpRef = useRef<PendingPromptJump | null>(null)
  const viewHoldRef = useRef<ViewHold | null>(null)

  const handleLoadOlderTopTrigger = useCallback(() => {
    // A prompt jump owns the scroll position until it lands: revealing or
    // loading turns above it now would restore the view out from under it.
    const jump = pendingJumpRef.current
    if (promptJumpRef.current || (jump && performance.now() < jump.until)) return
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

  // ── Follow state for the composer's jump chip ─────────────────────────────
  // Counted from the newest block when the reader scrolled away, so earlier
  // messages loading in above never read as new.
  const followAnchorRef = useRef<string | null>(null)
  useEffect(() => {
    if (!jumpToLatestInComposer) return
    if (!showScrollBtn) {
      followAnchorRef.current = null
      if (useTranscriptFollowStore.getState().unseen !== null) useTranscriptFollowStore.setState({ unseen: null })
      return
    }
    followAnchorRef.current ??= (liveTail[liveTail.length - 1] ?? blocks[blocks.length - 1])?.id ?? ''
    const counted = countBlocksAfter(blocks, followAnchorRef.current, liveTail)
    // A reconcile can swap the anchor's id; keep the last count then.
    const unseen = counted ?? useTranscriptFollowStore.getState().unseen ?? 0
    if (useTranscriptFollowStore.getState().unseen !== unseen) useTranscriptFollowStore.setState({ unseen })
  }, [blocks, jumpToLatestInComposer, liveTail, showScrollBtn])
  useEffect(() => {
    if (!jumpToLatestInComposer) return
    useTranscriptFollowStore.setState({ jumpToLatest: () => scrollToBottom('smooth') })
    return () => useTranscriptFollowStore.setState({ jumpToLatest: null, unseen: null })
  }, [jumpToLatestInComposer, scrollToBottom])

  /** Hold the view while earlier turns land above it; call the release once they have. */
  const holdView = useCallback(() => {
    const root = scrollRef.current
    let hold = viewHoldRef.current
    if (!hold) {
      const anchor = root?.querySelector<HTMLElement>('[data-block-id]')
      hold = {
        sessionId,
        anchorId: anchor?.dataset.blockId ?? null,
        anchorTop: root && anchor ? contentTop(root, anchor) : 0,
        pending: 0,
      }
      viewHoldRef.current = hold
    }
    hold.pending += 1
    const held = hold
    // By the next frame every commit the reveal or load caused has run.
    return () => requestAnimationFrame(() => {
      held.pending -= 1
      if (held.pending === 0 && viewHoldRef.current === held) viewHoldRef.current = null
    })
  }, [scrollRef, sessionId])

  const showEarlierTurns = useCallback(() => {
    const release = holdView()
    setRenderedTurnCount((count) => Math.min(turnItems.length, count + TURN_RENDER_STEP))
    release()
  }, [holdView, turnItems.length])

  const handleLoadOlderTop = useCallback(() => {
    if (hiddenTurnCountRef.current > 0) {
      showEarlierTurns()
    } else if (useAgentStore.getState().hasMore && !loadingOlderRef.current) {
      loadingOlderRef.current = true
      const release = holdView()
      void useAgentStore.getState().loadOlderMessages().finally(() => {
        loadingOlderRef.current = false
        release()
      })
    }
  }, [holdView, showEarlierTurns])

  // Keep the refs in sync so callbacks/listeners always see
  // the latest values without needing to re-register listeners.
  useEffect(() => {
    onLoadOlderTopRef.current = handleLoadOlderTop
    hiddenTurnCountRef.current = hiddenTurnCount
    showEarlierTurnsRef.current = showEarlierTurns
  })

  // ── Prompt navigation ──────────────────────────────────────────────────────
  const scrollPromptIntoView = useCallback((prompt: HTMLElement) => {
    const root = scrollRef.current
    if (!root) return
    const view = root.getBoundingClientRect()
    const distance = prompt.getBoundingClientRect().top - view.top - PROMPT_JUMP_MARGIN
    // Past a couple of screens a smooth scroll only paints the turns in between.
    const smooth = Math.abs(distance) <= 2 * view.height && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    attachedRef.current = false
    root.scrollTo({ top: root.scrollTop + distance, behavior: smooth ? 'smooth' : 'auto' })
    pendingJumpRef.current = prompt.dataset.promptId
      ? { id: prompt.dataset.promptId, until: performance.now() + PROMPT_JUMP_MS }
      : null
  }, [attachedRef, scrollRef])

  /** Start a jump that lands once a reveal or load renders its turns; call the result when that has settled. */
  const beginPromptJump = useCallback((targetId: string | null) => {
    const job: PendingPromptJump = { targetId, jump: true }
    promptJumpRef.current = job
    const release = holdView()
    return () => {
      release()
      requestAnimationFrame(() => {
        if (promptJumpRef.current === job) promptJumpRef.current = null
      })
    }
  }, [holdView])

  /**
   * Previous prompt when none is rendered above: find it in the loaded turns,
   * else load pages until one holds it, then render only down to it and jump
   * (see the layout effect below).
   */
  const requestOlderPrompt = useCallback(() => {
    const pending = promptJumpRef.current
    if (pending) {
      pending.jump = true
      return
    }
    const target = previousPromptTurn(turnItems, hiddenTurnCount)
    if (target < 0 && !useAgentStore.getState().hasMore) {
      // No earlier prompt at all: show whatever earlier turns remain.
      onLoadOlderTopRef.current()
      return
    }
    const settle = beginPromptJump(null)
    if (target >= 0) {
      setRenderedTurnCount((count) => Math.max(count, turnItems.length - target))
      settle()
      return
    }
    void useAgentStore.getState().loadOlderUntilPrompt().catch(() => false).then(settle)
  }, [beginPromptJump, hiddenTurnCount, turnItems])

  // Earlier turns landed: hold the view where it was, then make a pending
  // prompt jump. Before paint, so neither the shift nor the reveal flashes.
  useLayoutEffect(() => {
    const hold = viewHoldRef.current
    const root = scrollRef.current
    if (!hold || !root) return
    if (hold.sessionId !== sessionId) {
      viewHoldRef.current = null
      promptJumpRef.current = null
      return
    }
    const anchor = hold.anchorId === null ? undefined : blockElement(root, hold.anchorId)
    if (anchor) {
      const top = contentTop(root, anchor)
      if (top !== hold.anchorTop) root.scrollTop += top - hold.anchorTop
      hold.anchorTop = top
    }
    const jump = promptJumpRef.current
    if (!jump?.jump) return
    const target = jump.targetId !== null
      ? turnIndexOfBlock(turnItems, jump.targetId)
      : hold.anchorId === null ? -1 : previousPromptTurn(turnItems, turnIndexOfBlock(turnItems, hold.anchorId))
    if (target < 0) return
    if (target < hiddenTurnCount) {
      setRenderedTurnCount(turnItems.length - target)
      return
    }
    const item = turnItems[target]
    const id = jump.targetId ?? (item.kind === 'user' ? item.block.id : undefined)
    const prompt = id === undefined ? undefined : blockElement(root, id)
    if (!prompt) return
    promptJumpRef.current = null
    scrollPromptIntoView(prompt)
  }, [hiddenTurnCount, scrollPromptIntoView, scrollRef, sessionId, turnItems])

  // Scrolling by hand while earlier turns load means the reader went elsewhere.
  const cancelPromptJump = useCallback(() => {
    if (promptJumpRef.current) promptJumpRef.current.jump = false
  }, [])

  /** Bring a loaded prompt into view by block id, rendering down to it when it is hidden. */
  const showPrompt = useCallback((id: string) => {
    const root = scrollRef.current
    if (!root) return
    cancelPromptJump()
    const rendered = blockElement(root, id)
    if (rendered) {
      scrollPromptIntoView(rendered)
      return
    }
    const index = turnIndexOfBlock(turnItems, id)
    if (index < 0 || index >= hiddenTurnCount) return
    const settle = beginPromptJump(id)
    setRenderedTurnCount((count) => Math.max(count, turnItems.length - index))
    settle()
  }, [beginPromptJump, cancelPromptJump, hiddenTurnCount, scrollPromptIntoView, scrollRef, turnItems])

  // The composer's ↑/↓ recall shows the prompt it recalled.
  const showPromptRef = useRef(showPrompt)
  useEffect(() => {
    showPromptRef.current = showPrompt
  })
  useEffect(() => {
    useTranscriptFollowStore.setState({ showPrompt: (id) => showPromptRef.current(id) })
    return () => useTranscriptFollowStore.setState({ showPrompt: null })
  }, [])

  const jumpToPrompt = useCallback((direction: -1 | 1) => {
    const root = scrollRef.current
    if (!root) return
    if (direction > 0) cancelPromptJump()
    const rootTop = root.getBoundingClientRect().top
    const prompts = promptElements(root)
    const pending = pendingJumpRef.current
    const from = pending && performance.now() < pending.until
      ? prompts.findIndex((el) => el.dataset.promptId === pending.id)
      : -1
    const index = from >= 0
      ? from + direction
      : promptJumpTarget(prompts.map((el) => el.getBoundingClientRect().top - rootTop), PROMPT_JUMP_MARGIN, direction)
    if (index >= 0 && index < prompts.length) {
      scrollPromptIntoView(prompts[index])
      return
    }
    pendingJumpRef.current = null
    // Past the newest prompt is the live end; before the oldest, earlier turns.
    if (direction > 0) scrollToBottom('smooth')
    else requestOlderPrompt()
  }, [cancelPromptJump, requestOlderPrompt, scrollPromptIntoView, scrollRef, scrollToBottom])

  // The mobile chat actions step prompts without a keyboard.
  const jumpToPromptRef = useRef(jumpToPrompt)
  useEffect(() => {
    jumpToPromptRef.current = jumpToPrompt
  })
  useEffect(() => {
    useTranscriptFollowStore.setState({ jumpToPrompt: (direction) => jumpToPromptRef.current(direction) })
    return () => useTranscriptFollowStore.setState({ jumpToPrompt: null })
  }, [])

  useShortcuts([
    appShortcut('previousPrompt', () => { jumpToPrompt(-1) }),
    appShortcut('nextPrompt', () => { jumpToPrompt(1) }),
  ])

  const cycleFind = useCallback((delta: number) => {
    if (findMatches.length === 0) return
    const next = ((clampedFindIndex + delta) % findMatches.length + findMatches.length) % findMatches.length
    onFindActiveIndexChange?.(next)
  }, [clampedFindIndex, findMatches.length, onFindActiveIndexChange])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    if (!findOpen) {
      clearTranscriptFind()
      return
    }
    const paint = (scrollActive: boolean) => {
      const active = paintTranscriptFind(root, deferredFindQuery, clampedFindIndex)
      if (scrollActive && active) {
        attachedRef.current = false
        scrollRangeToCenter(root, active)
      }
    }
    // Painting never touches the DOM, so this only sees React's own updates
    // (a streamed token, a fold opening). Those move text under the painted
    // ranges; repaint once per frame, however many arrived.
    let frame: number | null = null
    const observer = new MutationObserver(() => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        paint(false)
      })
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true })
    paint(true)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      clearTranscriptFind()
    }
  }, [attachedRef, clampedFindIndex, deferredFindQuery, findOpen, scrollRef])

  return (
    <FileRefContext.Provider value={fileRefOpener ?? null}>
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
    <div className="group/transcript relative flex min-h-0 flex-1 flex-col">
    {/* Vertical only: ``overflow-y: auto`` alone turns ``overflow-x`` to auto, and
        one over-wide row then let the whole transcript pan sideways on touch.
        Code, tables and diagrams scroll inside their own boxes. */}
    <div ref={scrollRef} onWheel={cancelPromptJump} onTouchMove={cancelPromptJump} className="oa-chat-scroll flex-1 overflow-x-hidden overflow-y-auto">
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
                       data-block-id={item.block.id}
                       data-find-block={isTranscriptFindableBlock(item.block.type) ? item.block.id : undefined}
                      data-prompt-id={isDirectUserBlock(item.block) ? item.block.id : undefined}
                     >
                       <BlockRenderer
                         block={item.block}
                         isStreaming={false}
                         sessionId={sessionId}
                         onEdit={editHandler}
                         promptModel={promptModelById.get(item.block.id)?.model}
                         promptThinkingLevel={promptModelById.get(item.block.id)?.thinkingLevel}
                         latestMCPAppBlockIds={mcpAppResourceUri(item.block) ? latestMCPAppBlockIds : undefined}
                         onMentionFileOpen={onMentionFileOpen}
                         onOpenSession={onOpenSession}
                       />
                     </div>
                   )
                 }
                 // Me only the trailing turn (no user block after) can be "live"
                  const isTrailingTurn = globalTurnIndex === turnItems.length - 1
                  // The running turn is timed from its prompt: unlike the stream's
                  // own start mark, the prompt's time survives a reload.
                  const prompt = isTrailingTurn ? turnItems[globalTurnIndex - 1] : undefined
                  const turnStartedAt = prompt?.kind === 'user' ? prompt.block.timestamp?.getTime() : undefined
                 return (
                   <AssistantTurn
                     key={`turn-${item.blocks[0]?.id ?? item.startIndex}`}
                     blocks={item.blocks}
                     startIndex={item.startIndex}
                     // Only the trailing turn can hold the last or a streaming
                     // block; a finished turn gets constants so its memo holds
                     // as the transcript grows.
                     finalizedCount={isTrailingTurn ? blocks.length : 0}
                     isWorking={isWorking}
                     isTurnOpen={isTurnOpen}
                     isTrailingTurn={isTrailingTurn}
                      totalBlocks={isTrailingTurn ? totalLen : 0}
                      size="roomy"
                     reader={readerTranscript}
                     startedAt={turnStartedAt}
                     findHitBlockIds={readerTranscript ? findHitBlockIds : undefined}
                      renderBlock={renderTurnBlock}
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
             * Not for (2) when reader mode folded a report into the running
             * turn: its work row already reads "Working".
             * Covers the POST to first SSE event gap so the user always gets immediate feedback.
             */}
            {((!isTurnOpen && !isError && currentBlocks.some(isDirectUserBlock)) ||
              isAwaitingRestart ||
              (isWorking && !answerHoldsReport && currentBlocks.every((b) => b.type === 'user' || isBlankContentBlock(b)))) && (
              <div className="flex items-center gap-1.5 py-1" role="status" aria-label="Agent is preparing a response">
                <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '0ms' }} />
                <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '150ms' }} />
                <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '300ms' }} />
              </div>
            )}

            <PendingMessageQueue />

            {showsLastError && lastError && (
              <ErrorCard message={lastError} onRetry={errorRetry} onSwitchModel={errorSwitchModel} />
            )}

           <div ref={anchorRef} data-chat-scroll-anchor aria-hidden="true" />
         </div>
      </div>
    </div>
    <TimelineScrubber
      scrollRef={scrollRef}
      contentRef={contentRef}
      findBlockIds={findBlockIds}
      activeFindBlockId={activeFindBlockId}
    />
    </div>
    {showScrollBtn && !jumpToLatestInComposer && (
        <button
          onClick={() => scrollToBottom('smooth')}
          // Centred by margin rather than a percentage translate (DESIGN.md:
          // no transform-based layout).
          className="absolute inset-x-0 bottom-16 z-10 mx-auto flex h-7 w-7 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) active:scale-90 motion-reduce:active:scale-100"
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={14} />
        </button>

    )}
    </div>
    </FileRefContext.Provider>
  )
}
