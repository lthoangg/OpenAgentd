// size-ceiling: 974 — one body: the render window, earlier turns landing under a view hold (touch runway), and prompt jumps share refs with the auto-follow scroller
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
 * single `AssistantTurnFooter` (Copy response, files changed, and the turn's
 * details); only the trailing turn hides its footer while the turn is open.
 * The prompt's own row (model, Edit, Copy, time) is `UserBubble`'s, shown on
 * hover: a turn shows each of those once.
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { Seal } from '@/components/brand/Logo'

import { Loader2 } from 'lucide-react'
import { TimelineScrubber } from './TimelineScrubber'
import { AssistantTurn, type AssistantTurnProps } from '../AssistantTurnFooter'
import { PendingMessageQueue } from '../PendingMessageQueue'
import { WaitingForLine } from './WaitingForLine'
import { JumpToLatest } from '../JumpToLatestChip'
import { appendCurrentTurns, getVisibleTurnWindow, partitionTurns, promptModels, type TurnItem } from '@/utils/turns'
import { liveBlockTail } from '@/utils/blocks'
import { useUIStore } from '@/stores/useUIStore'
import { latestMCPAppResourceBlockIdsFromParts, latestMCPAppResources, mcpAppResourceUri } from '@/utils/mcp-app-artifacts'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { usePromptStepKeys } from './usePromptStepKeys'
import type { ContentBlock } from '@/api/types'
import type { OpenSessionHandler } from './UserBubble'
import { sentFrom } from '@/utils/workspace-messages'
import { isLeadMessage } from '@/utils/lead-messages'
import { ErrorCard } from './ErrorCard'
import { endingProviderError, isBlankContentBlock, isProviderErrorBlock, latestActiveRetryBlockId } from './provider-status'
import { TranscriptSkeleton } from './TranscriptSkeleton'
import { PendingDots } from './PendingDots'
import { QuotaWaitNotice, useQuotaWait } from './QuotaWaitNotice'
import { PROMPT_JUMP_MARGIN, previousPromptTurn, promptElements, promptJumpTarget, turnIndexOfBlock } from './prompt-nav'
import { isTypedPromptBlock } from '@/stores/useAgentStore/helpers'
import { FileRefContext, type FileRefOpener } from '../FileRefLink'
import { EmptyState } from '@/components/ui/empty-state'
import { olderZonePx, useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'
import { useDismissKeyboardOnTouch } from '@/hooks/use-mobile-viewport'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { useSessionSwitchHold } from './useSessionSwitchHold'
import { BlockRenderer } from './BlockRenderer'
import { useUnseenCount } from './useUnseenCount'

const INITIAL_RENDERED_TURNS = 80
const TURN_RENDER_STEP = 80
/**
 * On touch the reveal is smaller: mounting 80 turns at once cost a long
 * frame the reader saw as a stutter. Mid-fling smaller still, a few a
 * frame, so each fits the runway above the view.
 */
const TOUCH_TURN_RENDER_STEP = 16
const TOUCH_FLING_RENDER_STEP = 4
/**
 * Touch: empty room kept above the first turn while there is more to come,
 * in screens. Earlier turns land in it without moving the view; it is
 * topped up whenever the scroll rests.
 */
const RUNWAY_SCREENS = 3
const turnRenderStep = () => (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches ? TOUCH_TURN_RENDER_STEP : TURN_RENDER_STEP)
const ENTER_EASE = `cubic-bezier(${EASINGS.out.join(', ')})`
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

/** A turn's identity across renders: its first block. */
function turnKey(item: TurnItem): string {
  return item.kind === 'assistant' ? item.blocks[0]?.id ?? `@${item.startIndex}` : item.block.id
}

/** A pinned prompt stays up until an undo takes it back with the rest of its run. */
function pinnedPromptShows(prompt: ContentBlock, revertTime: number | null): boolean {
  const at = prompt.timestamp?.getTime()
  return revertTime === null || at === undefined || at < revertTime
}

/** The run picker, on its model list: how a failed turn gets another model. */
function openModelPicker(): void {
  useUIStore.getState().openRunPicker('model')
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
  /** Optional slot rendered in place of the default Seal empty state. */
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
  /**
   * The floating composer carries the jump-to-latest chip, so the transcript
   * publishes its follow state instead of drawing its own button.
   */
  jumpToLatestInComposer?: boolean
  /**
   * The main transcript: whether it has scrolled off its top is marked on the
   * chat shell (``data-transcript-scrolled``), so the phone header draws its
   * bottom line only once text passes under it, like an iOS navigation bar.
   */
  marksScrollEdge?: boolean
}

export function AgentView({
  blocks: storeBlocks,
  currentBlocks: storeCurrentBlocks,
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
  jumpToLatestInComposer = false,
  marksScrollEdge = false,
}: AgentViewProps) {
  const [renderedTurnCount, setRenderedTurnCount] = useState(INITIAL_RENDERED_TURNS)
  const storeSessionId = useAgentStore((s) => s.sessionId) ?? undefined
  // A saved session that is still loading only looks empty.
  const isLoadingHistory = useAgentStore((s) => s.isLoadingHistory)
  const storePinnedPrompt = useAgentStore((s) => s.pinnedPrompt)
  const leadRevertTime = useAgentStore((s) => s._leadRevertTime)
  // A switch keeps a transcript on screen until the next one lands (see the
  // hook). Everything below renders the displayed session, held or not.
  const hold = useSessionSwitchHold({
    sessionId: storeSessionId,
    blocks: storeBlocks,
    currentBlocks: storeCurrentBlocks,
    pinnedPrompt: storePinnedPrompt,
    isLoadingHistory,
  })
  const blocks = hold?.snapshot.blocks ?? storeBlocks
  const currentBlocks = hold?.snapshot.currentBlocks ?? storeCurrentBlocks
  const sessionId = hold?.snapshot.sessionId ?? storeSessionId
  // The held transcript is another session's: the store's parent is not its.
  const storeParentSessionId = useAgentStore((s) => s.parentSessionId) ?? undefined
  const leadSessionId = hold ? undefined : storeParentSessionId
  // A run longer than the first page loads without the prompt it answers;
  // that prompt is pinned above the loaded rows until its own page lands.
  const shownPinnedPrompt = hold ? hold.snapshot.pinnedPrompt : storePinnedPrompt
  const pinnedPrompt = shownPinnedPrompt && pinnedPromptShows(shownPinnedPrompt, hold ? null : leadRevertTime) ? shownPinnedPrompt : null
  const loadingOlderRef = useRef(false)
  const hiddenTurnCountRef = useRef(0)
  const onLoadOlderTopRef = useRef<(moving?: boolean) => void>(() => {})
  // Touch history loading, with its runway (see ``loadOlderOnTouch``).
  const [touchHistory] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
  const runwayRef = useRef<HTMLDivElement>(null)
  const fillAtRestRef = useRef<() => void>(() => {})
  /** The runway's height; its inline style is the record, so a remount resets it. */
  const runwayPx = useCallback(() => parseFloat(runwayRef.current?.style.height ?? '') || 0, [])
  const setRunwayPx = useCallback((px: number) => {
    if (runwayRef.current) runwayRef.current.style.height = `${Math.max(0, Math.round(px))}px`
  }, [])
  const onScrollRest = useCallback(() => fillAtRestRef.current(), [])

  // The store puts the prompt back in the composer via ``pendingDraft``.
  const handleEdit = useCallback((blockId: string) => {
    void useAgentStore.getState().revertToMessage(blockId)
  }, [])
  // While a turn runs a prompt cannot be rewound: Edit shows, disabled, with its reason.
  const editLocked = isTurnOpen

  // Live blocks not yet folded into `blocks`, deduped against confirmed ids.
  // Both scroll bookkeeping and turn partitioning below read from this same
  // array, so they can never disagree about what actually renders (a merged
  // `[...blocks, ...liveTail]` copy is never needed here — nothing reads full
  // merged content, only counts and the last block).
  const liveTail = useMemo(() => liveBlockTail(blocks, currentBlocks), [blocks, currentBlocks])
  const readerTranscript = useDisplayPrefsStore((s) => s.transcriptStyle === 'reader')
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
  // The lead's message, or another workspace agent's, is not the user's to resend.
  const canRetry = Boolean(onRetry) && !isTurnOpen && latestPrompt !== undefined && isTypedPromptBlock(latestPrompt.block) && !isLeadMessage(latestPrompt.block, leadSessionId) && !sentFrom(latestPrompt.block.extra) && !answerHoldsReport
  // A failed turn offers its way forward on the failure itself: the card for
  // a failure the transcript does not show, else the error the turn ended on.
  const trailingBlocks = lastTurnItem?.kind === 'assistant' ? lastTurnItem.blocks : []
  const showsLastError = Boolean(isError && lastError) && !trailingBlocks.some(
    (b) => isProviderErrorBlock(b) && (b.extra?.message === lastError || b.content === lastError),
  )
  const endingErrorId = isTurnOpen || showsLastError ? undefined : endingProviderError(trailingBlocks)?.id
  const errorRetry = canRetry ? onRetry : undefined
  const errorSwitchModel = isTurnOpen ? undefined : onSwitchModel ?? openModelPicker
  // The render window counts back from the newest turn. A running session
  // adds turns at the end (a reply, a subagent's report, a steer), and a
  // sync can merge them again; counted from the end, each one hid or showed
  // a turn at the top, moving everything above the reader (on-device: long
  // and running sessions jumped). While the first turn is the same, the
  // hidden count holds; an older page or another session starts afresh.
  const firstTurnKey = turnItems.length === 0 ? '' : turnKey(turnItems[0])
  const [windowBase, setWindowBase] = useState({ key: firstTurnKey, length: turnItems.length })
  if (windowBase.key !== firstTurnKey || windowBase.length !== turnItems.length) {
    if (windowBase.key === firstTurnKey && firstTurnKey !== '') {
      const hiddenBefore = Math.max(0, windowBase.length - renderedTurnCount)
      const hiddenNow = Math.max(0, turnItems.length - renderedTurnCount)
      if (hiddenNow !== hiddenBefore) setRenderedTurnCount(turnItems.length - hiddenBefore)
    }
    setWindowBase({ key: firstTurnKey, length: turnItems.length })
  }
  const { hiddenTurnCount, visibleTurnItems } = useMemo(
    () => getVisibleTurnWindow(turnItems, renderedTurnCount),
    [renderedTurnCount, turnItems],
  )
  // The first history page reaches back to the latest prompt, or pins it when
  // the run is longer than the page. A server from before that sends only the
  // newest page, which one long agent run can fill with no prompt at all, and
  // reader mode folds the run into a short view that may not scroll, so
  // nothing ever asks for older pages. Fetch back to the nearest prompt once
  // per session so the run shows what it answers. The detailed transcript
  // renders that run in full, so it scrolls and loads older pages on its own.
  // The seek is capped well below the manual jump's budget: every page it
  // lands renders at once, as one turn, before the reader asked for any of it.
  const hasMoreHistory = useAgentStore((s) => s.hasMore)
  // An earlier page is on its way in above the first row (scrolling up, or a prompt jump).
  const loadingOlder = useAgentStore((s) => s._loadingOlder)
  const hasLoadedPrompt = useMemo(
    () => turnItems.some((item) => item.kind === 'user' && isTypedPromptBlock(item.block)),
    [turnItems],
  )
  const promptSeekedForRef = useRef<string | null>(null)
  const hasTurns = turnItems.length > 0
  const hasPinnedPrompt = pinnedPrompt !== null
  useEffect(() => {
    if (!readerTranscript || !hasMoreHistory || hasLoadedPrompt || hasPinnedPrompt || !hasTurns) return
    const state = useAgentStore.getState()
    // A page already on its way lands new turns, which runs this again.
    if (state._loadingOlder || promptSeekedForRef.current === (sessionId ?? '')) return
    promptSeekedForRef.current = sessionId ?? ''
    void state.loadOlderUntilPrompt(AUTO_PROMPT_SEEK_PAGES).catch(() => false)
  }, [hasLoadedPrompt, hasMoreHistory, hasPinnedPrompt, hasTurns, readerTranscript, sessionId, turnItems])
  // Pinned above the rendered turns only when none are hidden, so it always
  // sits right above the rows it belongs to.
  const showPinnedPrompt = pinnedPrompt !== null && hiddenTurnCount === 0
  // A running turn is timed from its prompt; a pinned one stands in for it.
  const pinnedStartedAt = pinnedPrompt && !hasLoadedPrompt ? pinnedPrompt.timestamp?.getTime() : undefined
  const finalizedMCPAppResources = useMemo(() => latestMCPAppResources(blocks), [blocks])
  // Rebuilt per token from the live blocks, but keyed on its contents so the
  // Set (and every renderer holding it) only changes when an app's latest
  // result does. Block ids never contain a newline.
  const latestMCPAppKey = [...latestMCPAppResourceBlockIdsFromParts(finalizedMCPAppResources, currentBlocks)].join('\n')
  const latestMCPAppBlockIds = useMemo(
    () => new Set(latestMCPAppKey ? latestMCPAppKey.split('\n') : []),
    [latestMCPAppKey],
  )
  const {
    activeBlockId: activeQuotaWaitBlockId,
    restored: restoredQuotaWait,
    visible: visibleQuotaWait,
  } = useQuotaWait({ blocks, liveTail, isTurnOpen, sessionId, held: hold !== null })
  const activeRetryBlockId = useMemo(
    () => (isTurnOpen ? latestActiveRetryBlockId(blocks, liveTail) : undefined),
    [blocks, isTurnOpen, liveTail],
  )

  // One renderer for every turn, so a finished turn's memo holds while the
  // live one streams. Inline in the turns' ``.map`` it was a new closure per
  // turn per render, which the React Compiler cannot cache either.
  const renderTurnBlock = useCallback<AssistantTurnProps['renderBlock']>(({ block, isStreaming }) => (
    <div
      data-block-id={block.id}
    >
      <BlockRenderer
        block={block}
        isStreaming={isStreaming}
        sessionId={sessionId}
        leadSessionId={leadSessionId}
        onRetry={block.id === endingErrorId ? errorRetry : undefined}
        onSwitchModel={block.id === endingErrorId ? errorSwitchModel : undefined}
        latestMCPAppBlockIds={mcpAppResourceUri(block) ? latestMCPAppBlockIds : undefined}
        onMentionFileOpen={onMentionFileOpen}
        onOpenSession={onOpenSession}
        activeQuotaWaitBlockId={activeQuotaWaitBlockId}
        activeRetryBlockId={activeRetryBlockId}
      />
    </div>
  ), [activeQuotaWaitBlockId, activeRetryBlockId, endingErrorId, errorRetry, errorSwitchModel, latestMCPAppBlockIds, leadSessionId, onMentionFileOpen, onOpenSession, sessionId])

  // The sessions this one still waits for, at the live end of the transcript,
  // while the turn runs and after it closes. One slot after every turn, so
  // the line is the same element throughout: the footer appears above it
  // when the turn closes, and an open list stays open. A subagent's own
  // session waits for nothing.
  const waitingLine = useMemo(() => (leadSessionId ? undefined : <WaitingForLine sessionId={sessionId} />), [leadSessionId, sessionId])

  const lastBlock = liveTail.length > 0 ? liveTail[liveTail.length - 1] : blocks[blocks.length - 1]
  // A change key for auto-follow, not the content itself: the streamed fields
  // only grow, so their lengths move whenever they do.
  const lastContent = lastBlock
    ? `${lastBlock.id}:${lastBlock.content?.length ?? -1}:${lastBlock.toolOutput?.length ?? -1}:${lastBlock.toolResult?.length ?? -1}:${lastBlock.toolDone ? 1 : 0}:${lastBlock.toolArgs?.length ?? -1}`
    : ''
  const isUserMessage = lastBlock ? isTypedPromptBlock(lastBlock) : false
  const isEmpty = !isWorking &&
    !blocks.some((b) => b.type !== 'compaction') &&
    !liveTail.some((b) => b.type !== 'compaction') &&
    !visibleQuotaWait

  // A jump just made; the next press steps on from its target.
  const pendingJumpRef = useRef<{ id: string; until: number } | null>(null)
  const promptJumpRef = useRef<PendingPromptJump | null>(null)
  const viewHoldRef = useRef<ViewHold | null>(null)

  const handleLoadOlderTopTrigger = useCallback((moving: boolean) => {
    // A prompt jump owns the scroll position until it lands: revealing or
    // loading turns above it now would restore the view out from under it.
    const jump = pendingJumpRef.current
    if (promptJumpRef.current || (jump && performance.now() < jump.until)) return
    onLoadOlderTopRef.current(moving)
  }, [])

  const {
    scrollRef,
    contentRef,
    anchorRef,
    isFollowing,
    stopFollowing,
    showScrollBtn,
    jumpToLatest: jumpToEnd,
    isScrollAtRest,
  } = useAutoFollowScroll({
    totalLen,
    lastContent,
    sessionId,
    isUserMessage,
    isEmpty,
    onLoadOlderTop: handleLoadOlderTopTrigger,
    topInset: runwayPx,
    onScrollRest,
  })
  // Phone: drag or tap the transcript to put the keyboard away.
  useDismissKeyboardOnTouch(scrollRef)

  // An attribute on the shell, not state: a scroll never re-renders the chat.
  useEffect(() => {
    const el = scrollRef.current
    const shell = marksScrollEdge ? el?.closest('[data-chat-shell]') : null
    if (!el || !shell) return
    let scrolled: boolean | null = null
    const sync = () => {
      const next = el.scrollTop > 1
      if (next === scrolled) return
      scrolled = next
      shell.toggleAttribute('data-transcript-scrolled', next)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    return () => {
      el.removeEventListener('scroll', sync)
      shell.removeAttribute('data-transcript-scrolled')
    }
  }, [marksScrollEdge, scrollRef])

  // A switch fades the next session's transcript in once it has something to
  // show, before paint so its first frame never shows at full strength. The
  // first session on mount, and the first message of a new or empty chat
  // (the draft hand-off has its own motion), appear as they are.
  const reducedMotion = useReducedMotion() ?? false
  const enteredSessionRef = useRef(isEmpty ? undefined : sessionId)
  useLayoutEffect(() => {
    if (isEmpty || !sessionId) {
      if (!isLoadingHistory) enteredSessionRef.current = undefined
      return
    }
    const previous = enteredSessionRef.current
    if (previous === sessionId) return
    enteredSessionRef.current = sessionId
    const el = contentRef.current
    if (previous === undefined || reducedMotion || !el || typeof el.animate !== 'function') return
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATIONS_S.fast * 1000, easing: ENTER_EASE })
  }, [contentRef, isEmpty, isLoadingHistory, reducedMotion, sessionId])

  // ── Follow state for the jump chip ─────────────────────────────────────────
  const inlineUnseen = useUnseenCount({ blocks, liveTail, showScrollBtn, readerTranscript, inComposer: jumpToLatestInComposer })

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
      // The hold shifts the view itself; native anchoring (on while reading,
      // index.css) would shift it a second time.
      if (root) root.dataset.viewHold = ''
    }
    hold.pending += 1
    const held = hold
    // By the next frame every commit the reveal or load caused has run.
    return () => requestAnimationFrame(() => {
      held.pending -= 1
      if (held.pending === 0 && viewHoldRef.current === held) {
        viewHoldRef.current = null
        delete scrollRef.current?.dataset.viewHold
      }
    })
  }, [scrollRef, sessionId])

  const showEarlierTurns = useCallback(() => {
    const release = holdView()
    setRenderedTurnCount((count) => Math.min(turnItems.length, count + turnRenderStep()))
    release()
  }, [holdView, turnItems.length])

  // A reveal on its way to the screen: the scroll events of one frame ask once.
  const revealBusyRef = useRef(false)

  /**
   * Touch: earlier turns, revealed or loaded, land in the runway (see
   * ``runwayPx``). The hold measures what landed and takes it out of the
   * runway, so the turns in view never move and scrollTop is never written
   * mid-fling, which on iOS stops the fling and flickers. A fling reveals a
   * few turns per frame, and only while the runway can take them; at rest
   * a full step comes in, and a write is invisible anyway. True when it
   * asked for something.
   */
  const loadOlderOnTouch = useCallback((moving: boolean): boolean => {
    const root = scrollRef.current
    if (!root || revealBusyRef.current) return false
    if (moving && runwayPx() < root.clientHeight / 2) return false
    if (hiddenTurnCountRef.current > 0) {
      revealBusyRef.current = true
      const release = holdView()
      const step = moving ? TOUCH_FLING_RENDER_STEP : TOUCH_TURN_RENDER_STEP
      // Committed now, so the hold sees it before its release frame.
      flushSync(() => setRenderedTurnCount((count) => Math.min(turnItemsLengthRef.current, count + step)))
      release()
      requestAnimationFrame(() => { revealBusyRef.current = false })
      return true
    }
    if (!useAgentStore.getState().hasMore || loadingOlderRef.current) return false
    loadingOlderRef.current = true
    // The page's turns land past the render window, to come in as above.
    const lengthBefore = turnItemsLengthRef.current
    setRenderedTurnCount((count) => Math.min(count, lengthBefore))
    const release = holdView()
    void useAgentStore.getState().loadOlderMessages().finally(() => {
      loadingOlderRef.current = false
      release()
      // The reader may be resting near the top, with no scroll to ask
      // again. Only when the page brought turns: an empty one would ask forever.
      requestAnimationFrame(() => {
        if (turnItemsLengthRef.current > lengthBefore) fillAtRestRef.current()
      })
    })
    return true
  }, [holdView, runwayPx, scrollRef])

  /**
   * At rest on touch: size the runway (three screens while there is more
   * to come and the reader is scrolled up, none otherwise), then bring in
   * earlier turns while the first one is near the top, a step a frame.
   */
  const fillAtRest = useCallback(() => {
    const root = scrollRef.current
    if (!touchHistory || !root || viewHoldRef.current || promptJumpRef.current || !isScrollAtRest()) return
    const more = hiddenTurnCountRef.current > 0 || useAgentStore.getState().hasMore
    const current = runwayPx()
    const target = more && !isFollowing() ? RUNWAY_SCREENS * root.clientHeight : 0
    if (more ? target > current : current > 0) {
      // Resized with the view held by hand: native anchoring (on while
      // reading) must not shift it as well.
      const anchor = root.querySelector<HTMLElement>('[data-block-id]')
      const before = anchor?.getBoundingClientRect().top
      root.dataset.viewHold = ''
      setRunwayPx(target)
      root.scrollTop += before === undefined || !anchor ? target - current : anchor.getBoundingClientRect().top - before
      requestAnimationFrame(() => { if (!viewHoldRef.current) delete root.dataset.viewHold })
    }
    if (root.scrollTop - runwayPx() > olderZonePx(root.clientHeight, true)) return
    if (loadOlderOnTouch(false)) requestAnimationFrame(() => fillAtRestRef.current())
  }, [isFollowing, isScrollAtRest, loadOlderOnTouch, runwayPx, scrollRef, setRunwayPx, touchHistory])
  useEffect(() => {
    fillAtRestRef.current = fillAtRest
  })

  const handleLoadOlderTop = useCallback((moving = false) => {
    if (touchHistory) {
      loadOlderOnTouch(moving)
    } else if (hiddenTurnCountRef.current > 0) {
      showEarlierTurns()
    } else if (useAgentStore.getState().hasMore && !loadingOlderRef.current) {
      loadingOlderRef.current = true
      const release = holdView()
      void useAgentStore.getState().loadOlderMessages().finally(() => {
        loadingOlderRef.current = false
        release()
      })
    }
  }, [holdView, loadOlderOnTouch, showEarlierTurns, touchHistory])

  // Keep the refs in sync so callbacks/listeners always see
  // the latest values without needing to re-register listeners. At commit,
  // so a frame callback right after it never reads the last render's counts.
  const turnItemsLengthRef = useRef(0)
  useLayoutEffect(() => {
    onLoadOlderTopRef.current = handleLoadOlderTop
    hiddenTurnCountRef.current = hiddenTurnCount
    turnItemsLengthRef.current = turnItems.length
  })

  // ── Prompt navigation ──────────────────────────────────────────────────────
  const scrollPromptIntoView = useCallback((prompt: HTMLElement) => {
    const root = scrollRef.current
    if (!root) return
    const view = root.getBoundingClientRect()
    const distance = prompt.getBoundingClientRect().top - view.top - PROMPT_JUMP_MARGIN
    // Past a couple of screens a smooth scroll only paints the turns in between.
    const smooth = Math.abs(distance) <= 2 * view.height && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    stopFollowing()
    root.scrollTo({ top: root.scrollTop + distance, behavior: smooth ? 'smooth' : 'auto' })
    pendingJumpRef.current = prompt.dataset.promptId
      ? { id: prompt.dataset.promptId, until: performance.now() + PROMPT_JUMP_MS }
      : null
  }, [scrollRef, stopFollowing])

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
      delete root.dataset.viewHold
      promptJumpRef.current = null
      return
    }
    const anchor = hold.anchorId === null ? undefined : blockElement(root, hold.anchorId)
    if (anchor) {
      const top = contentTop(root, anchor)
      let dy = top - hold.anchorTop
      // Touch: what landed above fills the runway first, so the view stays
      // put without a scrollTop write (see ``loadOlderOnTouch``).
      const runway = dy > 0 ? runwayPx() : 0
      if (runway > 0) {
        const taken = Math.min(dy, runway)
        setRunwayPx(runway - taken)
        dy -= taken
      }
      if (dy !== 0) root.scrollTop += dy
      hold.anchorTop = runway > 0 ? contentTop(root, anchor) : top
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
  }, [hiddenTurnCount, runwayPx, scrollPromptIntoView, scrollRef, sessionId, setRunwayPx, turnItems])

  // Scrolling by hand while earlier turns load means the reader went elsewhere.
  const cancelPromptJump = useCallback(() => {
    if (promptJumpRef.current) promptJumpRef.current.jump = false
  }, [])

  /** Jump to latest. A prompt jump still loading would land after it and take the reader back up. */
  const jumpToLatest = useCallback(() => {
    cancelPromptJump()
    pendingJumpRef.current = null
    jumpToEnd()
  }, [cancelPromptJump, jumpToEnd])
  useEffect(() => {
    if (!jumpToLatestInComposer) return
    useTranscriptFollowStore.setState({ jumpToLatest })
    return () => useTranscriptFollowStore.setState({ jumpToLatest: null, unseen: null })
  }, [jumpToLatest, jumpToLatestInComposer])

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
    if (direction > 0) jumpToEnd()
    else requestOlderPrompt()
  }, [cancelPromptJump, jumpToEnd, requestOlderPrompt, scrollPromptIntoView, scrollRef])

  // The mobile chat actions step prompts without a keyboard.
  const jumpToPromptRef = useRef(jumpToPrompt)
  useEffect(() => {
    jumpToPromptRef.current = jumpToPrompt
  })
  useEffect(() => {
    useTranscriptFollowStore.setState({ jumpToPrompt: (direction) => jumpToPromptRef.current(direction) })
    return () => useTranscriptFollowStore.setState({ jumpToPrompt: null })
  }, [])

  usePromptStepKeys(jumpToPrompt)

  return (
    <FileRefContext.Provider value={fileRefOpener ?? null}>
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div className="group/transcript relative flex min-h-0 flex-1 flex-col">
    {/* Vertical only: ``overflow-y: auto`` alone turns ``overflow-x`` to auto, and
        one over-wide row then let the whole transcript pan sideways on touch.
        Code, tables and diagrams scroll inside their own boxes. */}
    <div
      ref={scrollRef}
      onWheel={cancelPromptJump}
      onTouchMove={cancelPromptJump}
      // F6 stops here; focused itself, so the arrow and page keys scroll it.
      // Its ring is inset: it fills a column that clips overflow.
      data-focus-region="transcript"
      data-region-self=""
      data-focus-ring="inset"
      aria-label="Transcript"
      className="oa-chat-scroll flex-1 overflow-x-hidden overflow-y-auto"
    >
      {/* A held transcript (a switch in progress) is for looking at only.
          The one being left dims while the next one loads. */}
      <div
        ref={contentRef}
        inert={hold !== null}
        data-session-hold={hold?.kind}
        className={`mx-auto max-w-3xl px-3 py-5 transition-opacity duration-(--motion-fast) ease-(--ease-in-out) sm:px-4 sm:py-6${hold?.kind === 'outgoing' ? ' opacity-70' : ''}`}
      >
        {isEmpty && isLoadingHistory && <TranscriptSkeleton />}
        {/* Touch: room above the first turn for earlier ones to land in
            without moving the view (``loadOlderOnTouch``). Sized by hand;
            a new session remounts it empty. */}
        {touchHistory && !isEmpty && <div key={sessionId} ref={runwayRef} aria-hidden="true" data-history-runway="" />}
        {isEmpty && !isLoadingHistory && (
           emptyState ?? (
             // Same weight as every other blank state (see `EmptyState`); the
             // Seal rides in the chip instead of as a 4xl hero.
             <EmptyState
               fill={false}
               className="py-16 select-none"
               icon={<Seal size={16} className="text-(--color-text)" />}
               title="Ask anything"
             />
           )
         )}

         {/* Earlier pages on their way: a pill pinned to the top of the view,
             in a box of no height, so its coming and going never moves the
             turns (a row here shifted them twice per page, a flicker). */}
         {loadingOlder && (
           <div data-loading-earlier-slot="" className="pointer-events-none sticky top-0 z-10 flex h-0 justify-center">
             <div role="status" data-loading-earlier="" className="mt-1 flex items-center gap-2 rounded-full bg-(--bg-card) px-3 py-1 text-xs text-(--color-text-muted) shadow-(--shadow-depth) animate-in fade-in-0 animation-duration-(--motion-fast)">
               <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
               Loading earlier messages…
             </div>
           </div>
         )}
         <div className="space-y-3">
              {/* Turns past the render window, and older pages, come in as the
                  reader scrolls to the top (``handleLoadOlderTop``). */}
              {showPinnedPrompt && (
                <>
                  {/* The run's prompt, above its newest rows. No ``data-block-id``:
                      a view hold anchors on loaded rows, so the gap fills
                      below this without moving the view. */}
                  <div data-prompt-id={pinnedPrompt.id} data-pinned-prompt="">
                    <BlockRenderer
                      block={pinnedPrompt}
                      isStreaming={false}
                      sessionId={sessionId}
                      leadSessionId={leadSessionId}
                      onMentionFileOpen={onMentionFileOpen}
                      onOpenSession={onOpenSession}
                    />
                  </div>
                  {/* Where the rows between the prompt and the page sit, unloaded. */}
                  <div aria-hidden="true" data-history-gap="" className="border-t border-dashed border-(--color-border-strong)" />
                </>
              )}
              {visibleTurnItems.map((item, k) => {
                 const globalTurnIndex = hiddenTurnCount + k
                 if (item.kind === 'user') {
                   return (
                     <div
                       key={item.block.id}
                       data-block-id={item.block.id}
                      data-prompt-id={isTypedPromptBlock(item.block) ? item.block.id : undefined}
                     >
                       <BlockRenderer
                         block={item.block}
                         isStreaming={false}
                         sessionId={sessionId}
                         leadSessionId={leadSessionId}
                         onEdit={handleEdit}
                         editLocked={editLocked}
                         promptModel={promptModelById.get(item.block.id)?.model}
                         promptThinkingLevel={promptModelById.get(item.block.id)?.thinkingLevel}
                         latestMCPAppBlockIds={mcpAppResourceUri(item.block) ? latestMCPAppBlockIds : undefined}
                         onMentionFileOpen={onMentionFileOpen}
                         onOpenSession={onOpenSession}
                       />
                     </div>
                   )
                 }
                 if (item.kind === 'compaction') {
                   // A ``/compact`` or idle compaction after a reply, on its
                   // own so the reply keeps its footer (see ``utils/turns.ts``).
                   return (
                     <div key={item.block.id} data-block-id={item.block.id}>
                       <BlockRenderer
                         block={item.block}
                         isStreaming={isWorking && item.block.extra?.state === 'compacting'}
                         sessionId={sessionId}
                       />
                     </div>
                   )
                 }
                 // Me only the trailing turn (no user block after) can be "live"
                  const isTrailingTurn = globalTurnIndex === turnItems.length - 1
                  // The running turn is timed from its prompt: unlike the stream's
                  // own start mark, the prompt's time survives a reload.
                  const prompt = isTrailingTurn ? turnItems[globalTurnIndex - 1] : undefined
                  const turnStartedAt = prompt?.kind === 'user' ? prompt.block.timestamp?.getTime() : isTrailingTurn ? pinnedStartedAt : undefined
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
                      renderBlock={renderTurnBlock}
                   />
                 )
                })}

            {/* ``-mt-1`` keeps the footer's own gap (``space-y-2``) above it. */}
            {waitingLine && <div className="-mt-1 empty:hidden">{waitingLine}</div>}

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
            {((!isTurnOpen && !isError && currentBlocks.some(isTypedPromptBlock)) ||
              isAwaitingRestart ||
              (isWorking && !answerHoldsReport && currentBlocks.every((b) => b.type === 'user' || isBlankContentBlock(b)))) && (
              <PendingDots />
            )}

            {/* Queued and steer messages wait here, faded, under the turn
                they are queued behind, in every session. */}
            <PendingMessageQueue />

            {showsLastError && lastError && (
              <div className="oa-fade-in">
                <ErrorCard message={lastError} onRetry={errorRetry} onSwitchModel={errorSwitchModel} />
              </div>
            )}

           <div ref={anchorRef} data-chat-scroll-anchor aria-hidden="true" />
         </div>
      </div>
    </div>
    <TimelineScrubber
      scrollRef={scrollRef}
      contentRef={contentRef}
    />
    </div>
    {/* The floating composer carries the chip when it is up; with none (a
        subagent's session) the same chip sits in the transcript's corner. */}
    {!jumpToLatestInComposer && (
      <JumpToLatest unseen={showScrollBtn ? inlineUnseen ?? 0 : null} side="inside" fadeOut={false} onJump={jumpToLatest} />
    )}
    </div>
    </FileRefContext.Provider>
  )
}
