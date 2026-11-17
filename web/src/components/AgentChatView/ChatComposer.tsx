/**
 * The chat's composer as this view wires it: where a submit goes (a side
 * question, a built-in slash command, or a message after user commands
 * expand), Stop, prompt recall, the mode toggle and its placeholder, redo,
 * the run deck and context meter under the box, and what sits pinned above
 * it (who drives the session, the run's question or plan, side questions).
 */
import { useCallback, useEffect, type RefObject } from 'react'
import type { AgentCapabilities, ContentBlock } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'
import type { AgentStoreState } from '@/stores/useAgentStore/types'
import { useBtwStore } from '@/stores/useBtwStore'
import { useToastStore } from '@/stores/useToastStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { PinnedQuestion } from '../AskUser'
import { BtwPanel } from '../BtwPanel'
import { Composer, type ComposerProps } from '../composer/Composer'
import { ContextMeter } from '../composer/ContextMeter'
import { PlusMenu, type ComposerActions } from '../composer/PlusMenu'
import { PhoneStatusLine, RunBar } from '../composer/RunBar'
import { RunChip } from '../composer/RunChip'
import type { RunSettings } from '../composer/useRunSettings'
import type { InputComposerHandle } from '../InputComposer'
import { PinnedPlanReview } from '../PlanReview/PlanReviewCard'
import { HandledByStrip } from './HandledByStrip'
import { deliverFromComposer, pushStoppedToast, stopTurn } from './heldMessages'
import { btwSubmit, newestUserBlockId, parseBuiltInSlashCommand } from './helpers'
import type { DraftHandoff } from './useDraftHandoff'

const EMPTY_BLOCKS: ContentBlock[] = []

interface ChatComposerProps {
  composerRef: RefObject<InputComposerHandle | null>
  placement: 'inline' | 'docked'
  draftHandoff: DraftHandoff
  workspace: string | null
  sessionId: AgentStoreState['sessionId']
  isDraft: boolean
  isSessionLoading: boolean
  isAgentWorking: boolean
  isPhone: boolean
  serverDown: boolean
  needsModelSetup: boolean
  capabilities: AgentCapabilities | undefined
  interactionMode: AgentStoreState['sessionInteractionMode']
  pendingInteractionMode: AgentStoreState['sessionPendingInteractionMode']
  isSwitchingInteractionMode: boolean
  onInteractionModeChange: NonNullable<ComposerProps['onInteractionModeChange']>
  slashCommands: NonNullable<ComposerProps['slashCommands']>
  snippetCommands: NonNullable<ComposerProps['snippetCommands']>
  onSlashCommand: (id: string) => unknown
  onSnippetCommand: ComposerProps['onSnippetCommand']
  /** A user command's text expanded, else the text as it is. */
  expandUserCommand: (content: string) => Promise<string>
  historyPrompts: string[]
  onDesignFeedbackRemoved: ComposerProps['onDesignFeedbackRemoved']
  onValueChange: ComposerProps['onValueChange']
  fileRefs: ComposerProps['fileRefs']
  onFileRefsNeeded: () => void
  revertedCount: number
  revertedMessages: NonNullable<ComposerProps['revertedMessages']>
  revertKeptFiles: boolean
  runSettings: RunSettings
  tokens: { input: number; output: number; cachedPercent?: number; trigger?: number }
  sessionCostUsd: number
  hasVisibleBlocks: boolean
  hasLiveBlocks: boolean
  sentFrom: AgentStoreState['sessionSentFrom']
  onOpenSession: (sessionId: string, workspace: string) => void
  onOpenSideQuestions: (sessionId: string) => void
  /** Desktop with a workspace: side questions live in the dock's BTW tab. */
  sideQuestionsInDock: boolean
  /** That tab is on screen. */
  sideQuestionsTabShown: boolean
  /** Called once the composer is mounted and ``composerRef`` is set. */
  onMount?: () => void
}

export function ChatComposer({
  composerRef,
  placement,
  draftHandoff,
  workspace,
  sessionId,
  isDraft,
  isSessionLoading,
  isAgentWorking,
  isPhone,
  serverDown,
  needsModelSetup,
  capabilities,
  interactionMode,
  pendingInteractionMode,
  isSwitchingInteractionMode,
  onInteractionModeChange,
  slashCommands,
  snippetCommands,
  onSlashCommand,
  onSnippetCommand,
  expandUserCommand,
  historyPrompts,
  onDesignFeedbackRemoved,
  onValueChange,
  fileRefs,
  onFileRefsNeeded,
  revertedCount,
  revertedMessages,
  revertKeptFiles,
  runSettings,
  tokens,
  sessionCostUsd,
  hasVisibleBlocks,
  hasLiveBlocks,
  sentFrom,
  onOpenSession,
  onOpenSideQuestions,
  sideQuestionsInDock,
  sideQuestionsTabShown,
  onMount,
}: ChatComposerProps) {
  const pushToast = useToastStore((s) => s.push)

  // The child composer's ref is set before this runs.
  useEffect(() => { onMount?.() }, [onMount])

  // ↑/↓ recall in the composer shows the recalled prompt in the transcript;
  // walking back out to an empty draft returns to the live end, as ⌥⌘↓ past
  // the newest prompt does. Reads blocks at call time to stay stable.
  const handleHistoryRecall = useCallback((prompt: string | null) => {
    const transcript = useTranscriptFollowStore.getState()
    if (prompt === null) {
      transcript.jumpToLatest?.()
      return
    }
    const { leadName, agentStreams } = useAgentStore.getState()
    const id = newestUserBlockId((leadName ? agentStreams[leadName]?.blocks : undefined) ?? EMPTY_BLOCKS, prompt)
    if (id) transcript.showPrompt?.(id)
  }, [])

  // ``/btw <question>``: a side question, never sent to the chat; a bare
  // ``/btw`` shows them again. Either shows the dock's BTW tab on desktop
  // with a workspace, else the panel above the composer. Returns false when
  // ``content`` is not one.
  // The composer clears itself right after submit, so a refused draft is
  // put back on the next task.
  const handleBtwSubmit = useCallback((content: string, files?: File[]): boolean => {
    const action = btwSubmit(content, files, sessionId)
    const giveBack = () => setTimeout(() => {
      composerRef.current?.setValue(content)
      if (files?.length) composerRef.current?.setFiles(files)
    }, 0)
    switch (action.kind) {
      case 'not-btw':
        return false
      case 'no-session':
        pushToast({ tone: 'info', title: 'Start a conversation first', description: 'Side questions answer from what the session already holds.' })
        giveBack()
        break
      case 'attachments':
        pushToast({ tone: 'error', title: "Side questions can't include attachments", description: 'Remove the files, or send them as a normal message.' })
        giveBack()
        break
      case 'reopen':
        if (sessionId) onOpenSideQuestions(sessionId)
        break
      case 'ask':
        if (!sessionId) break
        void useBtwStore.getState().ask(sessionId, action.question)
        onOpenSideQuestions(sessionId)
        break
    }
    return true
  }, [composerRef, sessionId, pushToast, onOpenSideQuestions])

  const composerMode = pendingInteractionMode ?? interactionMode
  const canAskSideQuestion = Boolean(sessionId) && (hasVisibleBlocks || hasLiveBlocks)
  const renderPlus = useCallback((actions: ComposerActions) => (
    <PlusMenu
      actions={actions}
      workspace={workspace}
      disabled={isSessionLoading}
      canAskSideQuestion={canAskSideQuestion}
      hasSnippets={snippetCommands.length > 0}
    />
  ), [workspace, isSessionLoading, canAskSideQuestion, snippetCommands.length])

  // Desktop with a workspace: the dock's BTW tab shows side questions, and
  // here only the chip reopens it while that tab is not on screen. A phone
  // shows it as the "btw" pill in the status line above the composer.
  const btwPanel = sideQuestionsTabShown ? null : (
    <BtwPanel
      sessionId={sessionId || null}
      countEnabled={hasVisibleBlocks}
      chipOnly={sideQuestionsInDock}
      onReopen={sideQuestionsInDock && sessionId ? () => onOpenSideQuestions(sessionId) : undefined}
    />
  )
  return (
    <Composer
      ref={composerRef}
      placement={placement}
      onHandoffCapture={draftHandoff.capture}
      enterFrom={draftHandoff.active ? draftHandoff.snapshot : null}
      onSubmit={async (content, files, mentions, delivery) => {
        if (!workspace) return
        if (handleBtwSubmit(content, files)) return
        if (!files || files.length === 0) {
          const builtInCmd = parseBuiltInSlashCommand(content)
          if (builtInCmd) {
            onSlashCommand(builtInCmd)
            return
          }
        }
        const expanded = await expandUserCommand(content)
        await deliverFromComposer(workspace, composerRef.current, { content: expanded, files, mentions }, delivery)
      }}
      onStop={() => {
        void stopTurn(composerRef.current)
        if (isPhone && workspace) pushStoppedToast(workspace, () => composerRef.current)
      }}
      onSlashCommand={onSlashCommand}
      onSnippetCommand={onSnippetCommand}
      slashCommands={slashCommands}
      snippetCommands={snippetCommands}
      historyPrompts={historyPrompts}
      onHistoryRecall={handleHistoryRecall}
      onDesignFeedbackRemoved={onDesignFeedbackRemoved}
      onValueChange={onValueChange}
      fileRefs={fileRefs}
      onFileRefsNeeded={onFileRefsNeeded}
      isStreaming={isAgentWorking}
      disabled={isSessionLoading}
      // Desktop: Send says the server is gone instead of looking ready; the
      // draft stays (desktop mockup 12.1). A phone keeps its send-and-restore.
      sendBlockedReason={serverDown && !isPhone ? "Can't reach the server. Your message stays here until it is back." : null}
      placeholder={
        // While a turn runs the composer shows its own queue/stop hint.
        isDraft && needsModelSetup
          ? 'Connect a model to start'
          : composerMode === 'plan'
            // Says what Plan mode does before the first message does it.
            ? 'Plan mode: the agent reads and writes a plan. It changes no files.'
            : 'Ask anything…'
      }
      capabilities={capabilities}
      // A switch requested mid-turn is queued server-side, so the toggle
      // shows what the user picked while the turn finishes under the old
      // mode.
      interactionMode={composerMode}
      interactionModePending={pendingInteractionMode !== null}
      onInteractionModeChange={onInteractionModeChange}
      // The new-session draft picks a mode locally; the first message carries it.
      interactionModeDisabled={isSwitchingInteractionMode || (!sessionId && !isDraft)}
      revertedCount={revertedCount}
      revertedMessages={revertedMessages}
      revertKeptFiles={revertKeptFiles}
      onRedo={() => { void onSlashCommand('redo') }}
      onRedoAll={() => { void onSlashCommand('redo-all') }}
      renderPlus={renderPlus}
      deck={(
        <RunChip
          settings={runSettings}
          disabled={isSessionLoading}
        />
      )}
      deckEnd={sessionId ? (
        <ContextMeter
          input={tokens.input}
          output={tokens.output}
          cachedPercent={tokens.cachedPercent}
          trigger={tokens.trigger}
          sessionCostUsd={sessionCostUsd}
          canSummarize={hasVisibleBlocks && !isAgentWorking}
        />
      ) : null}
      aboveComposer={(
        <>
          {/* Another workspace's agent is driving this session. */}
          <HandledByStrip sentFrom={sentFrom} onOpenSession={onOpenSession} />
          {/* What the run waits on, pinned so it cannot scroll away. */}
          <PinnedQuestion />
          <PinnedPlanReview />
          {isPhone ? (
            // One status line: the run on the left, the "btw" pill on the right.
            <PhoneStatusLine>
              <RunBar />
              {btwPanel}
            </PhoneStatusLine>
          ) : null}
          {!isPhone && btwPanel}
        </>
      )}
    />
  )
}
