// size-ceiling: 1315 — ChatFrame, AgentChatView and ActiveAgentView: one file each
/**
 * AgentChatView — top-level layout for the agent chat route.
 *
 * Owns:
 *   - Side panels (``Sidebar``, the Review panel, todos popover, command
 *     palette) and the docked composer with its run deck.
 *   - The header (token totals, panel toggles).
 *   - Mount-time SSE connect + session restore (carefully sequenced so
 *     ``loadSession`` runs *before* ``connectStream`` to avoid wiping
 *     replayed mid-turn state — see comment inside the init effect).
 *   - Keyboard shortcuts and the Command Palette assembly.
 *
 * Stream subscriptions are split into the smallest selectors that work
 * (one primitive per ``useAgentStore`` call) to avoid the infinite loop
 * that returning a freshly-built object on every render would trigger.
 */
import { failureToast } from '@/lib/failure-toast'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useNavigate } from '@tanstack/react-router'
import { ActiveAgentView } from './ActiveAgentView'
import type { FileRefOpener } from '../FileRefLink'
import { WorkspaceInfoCard } from '../WorkspaceInfoCard'
import { NewSessionScreen } from '../NewSession/NewSessionScreen'
import { ModelSetupCard } from '../NewSession/ModelSetupCard'
import { startNewSession } from '@/lib/new-session'
import { Sidebar } from '../Sidebar'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useClearSessionPlanMutation, useSessionPlanQuery } from '@/queries/useSessionPlanQuery'
import { useGoalControls, useSessionGoalQuery } from '@/queries/useSessionGoalQuery'
import { useGoalSessionState } from '@/hooks/useGoalSessionState'
import { goalHeaderState } from '@/lib/work'
import { useHealthQuery } from '@/queries'
import { isChatWorkspacePath, useChatWorkspace, useCheckoutLabel, useWorkspaceHasGit } from '@/queries/useChatWorkspace'
import { useAgentStore } from '@/stores/useAgentStore'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/stores/useUIStore'
import { useMarkSessionRead } from '@/stores/useUnreadStore'
import { useReportShownSession } from '@/lib/island-setting'
import { useStartInComposer, useStrandedFocusGuard } from '@/hooks/use-dock-focus'
import { previewsAvailable } from '@/api/preview'
import { useChatPreview } from './useChatPreview'
import { useDockCover } from './useDockCover'
import { useSessionLinks } from './useSessionLinks'
import { useLeadModel } from './useLeadModel'
import { useToastStore } from '@/stores/useToastStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useFileRefsQuery } from '@/queries/useFileRefsQuery'
import { FileUp } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useFocusRegions } from '@/hooks/use-focus-regions'
import { usePlatform } from '@/hooks/use-platform'
import { useTauriDrag } from '@/hooks/use-tauri-drag'
import { Button } from '@/components/ui/button'
import { type InputComposerHandle } from '../InputComposer'
import { useRunSettings } from '../composer/useRunSettings'
import { AppFooter } from '../AppFooter'
import { ViewErrorBoundary } from '../ViewErrorBoundary'
import { WorkspacePanel } from '../WorkspacePanel'
import { workspaceLabel } from '@/utils/workspace'
import { workspaceRelativePath } from '@/utils/file-refs'
import type { ContentBlock, MessageAttachment } from '@/api/types'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { TranscriptFind } from '@/components/TranscriptFind'
import { AgentChatHeader } from './AgentChatHeader'
import { ChatFrame, type PhoneStackState } from './ChatFrame'
import { ChatComposer } from './ChatComposer'
import { NoWorkspace, OpeningScreen, ServerUnreachable, SessionNotFound } from './ChatPlaceholders'
import { AgentChatPanels } from './AgentChatPanels'
import { ProviderSetupNotice } from './ProviderSetupNotice'
import { MissingFolderBanner, useFolderMissing } from './MissingFolderBanner'
import { takeQuietOpen } from '@/lib/quiet-open'
import { retryLatestPrompt } from './retryPrompt'
import { useDragDrop } from './useDragDrop'
import { useOverlayState } from './useOverlayState'
import { useSessionBootstrap } from './useSessionBootstrap'
import { useDraftHandoff } from './useDraftHandoff'
import { useSlashCommands } from './useSlashCommands'
import { useCommandPalette } from './useCommandPalette'
import { composerHistoryPrompts } from './helpers'
import { useReturnQueuedAfterFailure } from './heldMessages'

type RevertedMessage = { role: string; content: string; attachments?: MessageAttachment[] }
const EMPTY_BLOCKS: ContentBlock[] = []
const EMPTY_REVERTED_MESSAGES: RevertedMessage[] = []

interface AgentChatViewProps {
  sessionId?: string
  workspace?: string | null
  sessionLoading?: boolean
  /** The URL names a session the server does not have. */
  sessionNotFound?: boolean
  /**
   * A phone: the screen is a navigation stack, Servers under Sessions (the
   * sidebar as a page) with this chat pushed over it. ``atSessions``: the
   * chat is not on top (Sessions or Servers is). ``onBack``: up to Sessions
   * (‹, the edge swipe, Android Back).
   */
  phoneStack?: PhoneStackState
}

export function AgentChatView({ sessionId, workspace = null, sessionLoading = false, sessionNotFound = false, phoneStack }: AgentChatViewProps) {
  const navigate = useNavigate()
  // Opened while the server is down, nothing loaded, so no workspace is known:
  // say so instead of asking for a workspace.
  const serverDown = useHealthQuery().isError
  const openSettings = useSettingsStore((s) => s.openSettings)
  const pushToast = useToastStore((s) => s.push)
  const isMobile = useIsMobile()
  const isPhone = useIsPhone()
  const { isMacOverlay } = usePlatform()
  const storeWorkspace = useAgentStore((s) => s._workspace)
  const effectiveWorkspace = workspace || storeWorkspace
  // Chat sessions run on the same screen as project workspaces but the root is
  // not a repository: labels read "Chat" and the dock has no Git tab.
  const chatWorkspace = useChatWorkspace()
  const isChatWorkspace = isChatWorkspacePath(effectiveWorkspace, chatWorkspace)
  // Where you are decides: no Changes view, key or command in Chat or in a
  // folder without Git.
  const workspaceGit = useWorkspaceHasGit(effectiveWorkspace)
  const canOpenGit = !isChatWorkspace && workspaceGit !== false
  const workspaceName = effectiveWorkspace ? workspaceLabel(effectiveWorkspace, chatWorkspace) : ''
  // The header names a worktree by its repository too: "openagentd (fix-login)".
  const headerLabel = useCheckoutLabel(workspace)
  // Manual drag pattern: a mousedown handler that only starts a drag
  // when the user pressed on the bare header, not on a child button.
  // The hook returns `{}` outside Tauri so the spread is a no-op in
  // browsers. See ``useTauriDrag`` for details.
  const dragHandlers = useTauriDrag()
  const inputRef = useRef<InputComposerHandle>(null)
  // Handing focus back from the dock must not summon a collapsed composer.
  const returnFocusToComposer = useCallback(() => inputRef.current?.focus?.({ expand: false }), [])

  const [fileRefsEnabled, setFileRefsEnabled] = useState(false)
  const [isSwitchingInteractionMode, setIsSwitchingInteractionMode] = useState(false)

  const { isDraggingFile, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } = useDragDrop(inputRef)

  const storeState = useAgentStore(
    useShallow((s) => {
      const leadStream = s.leadName ? s.agentStreams[s.leadName] : undefined
      return {
        connectStream: s.connectStream,
        loadAgentStatus: s.loadAgentStatus,
        loadSession: s.loadSession,
        catchUpLiveTurn: s.catchUpLiveTurn,
        beginResolvedSession: s.beginResolvedSession,
        consumeResolvedSessionReady: s.consumeResolvedSessionReady,
        setupRequired: s.setupRequired,
        dismissSetupRequired: s.dismissSetupRequired,

        isAgentWorking: s.isAgentWorking,
        sessionId: s.sessionId,
        parentSessionId: s.parentSessionId,
        leadName: s.leadName,
        sessionTitle: s.sessionTitle,
        sessionSentFrom: s.sessionSentFrom,
        sessionInteractionMode: s.sessionInteractionMode,
        sessionPendingInteractionMode: s.sessionPendingInteractionMode,
        sessionModel: s.sessionModel,
        sessionFastMode: s.sessionFastMode,

        leadRevertedCount: leadStream?.revertedCount ?? 0,
        leadRevertedMessages: leadStream?.revertedMessages ?? EMPTY_REVERTED_MESSAGES,
        revertKeepsFiles: s.revertKeepsFiles,
        leadHasVisibleBlocks: (leadStream?.blocks.length ?? 0) > 0,
        leadHasLiveBlocks: (leadStream?.currentBlocks.length ?? 0) > 0,

        leadPromptTokens: leadStream?.usage.promptTokens ?? 0,
        leadCompletionTokens: leadStream?.usage.completionTokens ?? 0,
        leadCachedTokens: leadStream?.usage.cachedTokens ?? 0,
        leadCachedPercent: leadStream?.usage.cachedPercent,
        // The lead's and its subagents' spend so far.
        sessionCostUsd: Object.values(s.agentStreams).reduce((total, stream) => total + (stream.usage?.estimatedCostUsd ?? 0), 0),
      }
    })
  )

  const {
    connectStream,
    loadAgentStatus,
    loadSession,
    catchUpLiveTurn,
    beginResolvedSession,
    consumeResolvedSessionReady,
    setupRequired,
    dismissSetupRequired,

    isAgentWorking,
    sessionId: sessionIdState,
    parentSessionId,
    leadName,
    sessionTitle,
    sessionSentFrom,
    sessionInteractionMode,
    sessionPendingInteractionMode,
    sessionModel,

    leadRevertedCount,
    leadRevertedMessages,
    revertKeepsFiles,
    leadHasVisibleBlocks,
    leadHasLiveBlocks,
    leadPromptTokens,
    leadCompletionTokens,
    leadCachedTokens,
    leadCachedPercent,
    sessionCostUsd,
  } = storeState


  // Utility modal state lives in useUIStore so only one can be open at a time.
  const schedulerOpen = useUIStore((s) => s.schedulerOpen)
  const paletteOpen = useUIStore((s) => s.paletteOpen)
  const palettePage = useUIStore((s) => s.palettePage)
  const paletteKey = useUIStore((s) => s.paletteKey)
  const quickOpenOpen = useUIStore((s) => s.quickOpenOpen)
  const quickOpenQuery = useUIStore((s) => s.quickOpenQuery)
  const toggleScheduler = useUIStore((s) => s.toggleScheduler)
  const toggleRunPicker = useUIStore((s) => s.toggleRunPicker)
  const togglePalette = useUIStore((s) => s.togglePalette)
  const toggleQuickOpen = useUIStore((s) => s.toggleQuickOpen)
  const closeScheduler = useUIStore((s) => s.closeScheduler)
  const closePalette = useUIStore((s) => s.closePalette)
  const closeQuickOpen = useUIStore((s) => s.closeQuickOpen)

  const {
    mobileSidebarOpen,
    setMobileSidebarOpen,
    workspacePanel,
    setWorkspacePanel,
    fileViewer,
    setFileViewer,
    fileOpenKey,
    setFileOpenKey,
    terminalOpenKey,
    handledTerminalOpenKeyRef,
    terminalRunRequest,
    handledTerminalRunKeyRef,
    dockViewRequest,
    handledDockViewKeyRef,
    dockDiffRequest,
    handledDockDiffRequestKeyRef,
    dockPreviewRequest,
    handledDockPreviewRequestKeyRef,
    dockAttachmentRequest,
    handledDockAttachmentRequestKeyRef,
    dockLayoutRequest,
    handledDockLayoutKeyRef,
    dockLauncherFocusKey,
    handledDockLauncherFocusKeyRef,
    handleOpenAttachment,
    handleOpenPreview,
    dockActiveView,
    setDockActiveView,
    dockViewsEnabled,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarDrawer,
    sidebarDrawerOpen,
    setSidebarDrawerOpen,
    handleSplitDock,
    handleSplitDockDown,
    openWorkspaceDialogKey,
    searchSessionsKey,
    showTodos,
    handleWorkspaceFiles,
    handleOpenGit,
    handleSidebarToggle,
    handleOpenWorkspaceDialog,
    handleFileSelect,
    handleMentionFileOpen,
    handleFileRefOpen,
    handleDiffOpen,
    handleToggleRunPicker,
    handleToggleScheduler,
    handleTogglePalette,
    handleSwitchModel,
    handleToggleQuickOpen,
    handleSetShowTodos,
    handleToggleTasks,
    handleOpenPlan,
    handleOpenSideQuestions,
    handleOpenGoal,
    handleOpenTerminal,
    edgeSwipeHandlers,
  } = useOverlayState({
    isMobile,
    phoneStack,
    workspace,
    toggleScheduler,
    toggleRunPicker,
    togglePalette,
    toggleQuickOpen,
  })
  // F6 / ⇧F6 walk the window's areas (sidebar, transcript, composer, the
  // Review panel's groups, status bar). Phones have no keyboard areas.
  useFocusRegions(!isMobile)

  const { handleOpenSession, handleOpenLead } = useSessionLinks(parentSessionId)

  const leadBlocks = useAgentStore((s) => (
    s.leadName ? s.agentStreams[s.leadName]?.blocks ?? EMPTY_BLOCKS : EMPTY_BLOCKS
  ))
  const historyPrompts = useMemo(() => composerHistoryPrompts(leadBlocks), [leadBlocks])

  const { data: todosData } = useTodosQuery(sessionIdState)
  const todos = todosData?.todos ?? []
  const { data: planData } = useSessionPlanQuery(sessionIdState)
  const plan = planData?.plan ?? null
  const planAwaitingReview = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const { mutate: clearPlan } = useClearSessionPlanMutation()
  const handleClearPlan = useCallback(() => {
    if (!sessionIdState) return
    clearPlan(sessionIdState, {
      onError: (err) => pushToast(failureToast("Couldn't clear the plan", err)),
    })
  }, [sessionIdState, clearPlan, pushToast])

  // ── Session goal ───────────────────────────────────────────────────────────
  const { data: goalData } = useSessionGoalQuery(sessionIdState)
  const goal = goalData?.goal ?? null
  // The goal lives in the dock's Goal tab (its actions too): the palette
  // lists one entry that opens it, even before there is a goal, so it can be
  // found; the tab's empty state says how a goal starts.
  const paletteGoal = useMemo(
    () => (workspace ? { onShow: handleOpenGoal, active: Boolean(goal && goal.status !== 'cleared') } : undefined),
    [workspace, goal, handleOpenGoal],
  )
  // The header's Task list button shows the live goal as a ring and tooltip.
  const goalSession = useGoalSessionState(sessionIdState, goal)
  const headerGoalState = useMemo(() => goalHeaderState(goal, goalSession, todosData?.todos ?? []), [goal, goalSession, todosData])
  const goalControls = useGoalControls(sessionIdState)

  const agentWorkspace = workspace
  const hasWorkspace = Boolean(workspace)
  const folderMissing = useFolderMissing(sessionId ? workspace : null)
  const isSessionLoading = sessionLoading
  const {
    providersData,
    agentRegistryLoading,
    leadAgent,
    leadCapabilities,
    modelReady,
    needsModelSetup,
    summaryTriggerTokens,
  } = useLeadModel(workspace, sessionModel)
  // Workspace file/folder list for the InputComposer's @-mention picker.
  // Fetched lazily once a workspace is attached.
  const { refs: fileRefs } = useFileRefsQuery({
    workspace,
    enabled: fileRefsEnabled && Boolean(workspace),
  })

  const headerTokens = {
    input: leadPromptTokens,
    output: leadCompletionTokens,
    cached: leadCachedTokens,
    cachedPercent: leadCachedPercent,
    trigger: summaryTriggerTokens,
    pulsing: isAgentWorking,
  }

  const {
    handleNewSession,
    handleDraftValueChange,
    handleAddFileComment,
  } = useSessionBootstrap({
    sessionId,
    workspace,
    chatWorkspace,
    agentWorkspace,
    hasWorkspace,
    isSessionLoading,
    isMobile,
    paletteOpen,
    sessionTitle,
    isAgentWorking,
    inputRef,
    navigate,
    connectStream,
    loadAgentStatus,
    loadSession,
    catchUpLiveTurn,
    beginResolvedSession,
    consumeResolvedSessionReady,
  })

  // A new-session draft (`/?workspace=`): nothing saved yet, so the
  // new-session screen shows until the first message starts the turn.
  const isDraft = !sessionId && Boolean(workspace) && !sessionIdState && !isAgentWorking && !leadHasVisibleBlocks && !leadHasLiveBlocks
  // A chat already on screen stays through a switch: the loading states
  // below take the whole pane only when there is nothing to keep showing.
  const chatOnScreen = Boolean(sessionIdState) || leadHasVisibleBlocks
  // Desktop centers the composer in the draft screen; phones keep it docked.
  const composerInline = isDraft && !isMobile
  // The first message carries the draft into its chat as one motion.
  const reducedMotion = useReducedMotion() ?? false
  const draftHandoff = useDraftHandoff({ isDraft, sessionId, reducedMotion })
  const handleSelectDraftWorkspace = useCallback((path: string) => {
    startNewSession({ navigate, workspace: path, current: { sessionId, workspace }, replace: true })
  }, [navigate, sessionId, workspace])

  // ── Commands / shortcuts ───────────────────────────────────────────────────

  // ⌘F from the chat: find in the transcript on screen; a new session or a
  // switch closes it.
  const [findOpen, setFindOpen] = useState(false)
  const handleFindInSession = useCallback(() => setFindOpen(true), [])
  const closeFind = useCallback(() => {
    setFindOpen(false)
    returnFocusToComposer()
  }, [returnFocusToComposer])
  useEffect(() => {
    setFindOpen(false)
  }, [sessionIdState])

  const {
    handleOpenNewPreview,
    handleSendPreviewComments,
    handleDesignFeedbackRemoved,
  } = useChatPreview({ workspace, isMobile, inputRef, setWorkspacePanel, handleOpenPreview })

  const {
    slashCommands,
    snippetCommands,
    handleSlashCommand,
    handleSnippetCommand,
    expandUserCommand,
  } = useSlashCommands({
    agentWorkspace,
    inputRef,
    handleNewSession,
    isAgentWorking,
    revertedCount: leadRevertedCount,
    hasVisibleMessages: leadHasVisibleBlocks,
    hasLiveMessages: leadHasLiveBlocks,
    isChat: isChatWorkspace,
    hasConnectors: (leadAgent?.mcp_servers?.length ?? 0) > 0,
    onOpenSideQuestions: handleOpenSideQuestions,
  })

  useReturnQueuedAfterFailure({ sessionId: sessionIdState, composerRef: inputRef })
  useMarkSessionRead(sessionIdState)
  useReportShownSession(sessionIdState)

  const {
    paletteCommands,
    quickOpenWorkspaceFiles,
    quickOpenFilesTruncated,
    quickOpenFilesLoading,
    handleQuickOpenFileOpen,
  } = useCommandPalette({
    workspace,
    paletteOpen,
    quickOpenOpen,
    sessionIdState,
    workspacePanelOpen: workspacePanel !== null,
    handleNewSession,
    handleWorkspaceFiles,
    handleOpenGit: workspace && canOpenGit ? handleOpenGit : undefined,
    handleSidebarToggle,
    handleToggleRunPicker,
    handleToggleTasks,
    handleTogglePalette,
    handleToggleQuickOpen,
    handleToggleScheduler,
    handleOpenTerminal,
    handleSplitDock,
    handleSplitDockDown,
    handleFindInSession: sessionIdState ? handleFindInSession : undefined,
    handleOpenPlan,
    hasPlan: Boolean(plan),
    planAwaitingReview,
    handleOpenPreview: workspace && previewsAvailable() ? handleOpenNewPreview : undefined,
    handleOpenSideQuestions,
    goal: paletteGoal,
    setFileViewer,
    setFileOpenKey,
    setWorkspacePanel,
  })

  const {
    centerRef,
    dockOpen,
    dockKept,
    dockSlidesIn,
    chatCoveredByDock,
    transcriptCoveredByDock,
  } = useDockCover({ workspace, workspacePanel, isMobile, returnFocusToComposer })
  // A desktop app always has a focused control: never leave focus on
  // <body>, and start in the composer once a session is on screen (with a
  // mouse or trackpad; a touch tablet waits for a tap, see useStartInComposer).
  useStrandedFocusGuard(!isMobile, returnFocusToComposer)
  useStartInComposer(!isMobile && !isSessionLoading, sessionIdState, returnFocusToComposer, takeQuietOpen)

  const handleRetry = useCallback(() => {
    if (effectiveWorkspace) void retryLatestPrompt(effectiveWorkspace)
  }, [effectiveWorkspace])

  const fileRefOpener = useMemo<FileRefOpener | undefined>(() => (workspace
    ? {
        workspace,
        canOpen: (ref) => workspaceRelativePath(ref.path, workspace) !== null,
        open: (ref) => void handleFileRefOpen(ref),
        openDiff: (ref) => void handleDiffOpen(ref),
        ...(previewsAvailable() ? { openPreview: handleOpenPreview } : {}),
        // Phones keep the full-screen lightbox, with pinch-zoom and swipe.
        ...(dockViewsEnabled ? { openAttachment: handleOpenAttachment } : {}),
      }
    : undefined), [dockViewsEnabled, handleDiffOpen, handleFileRefOpen, handleOpenAttachment, handleOpenPreview, workspace])

  // How the next message runs, for the run deck under the composer.
  const runSettings = useRunSettings(workspace)

  // The docked composer's tray carries the jump-to-latest chip. With no
  // composer (a subagent's session, which only the main agent directs) the
  // chip stays in the transcript. The message queue is always in the transcript.
  const composerHoldsTray = !parentSessionId && Boolean(workspace)

  // One composer element: inside the new-session screen while that is
  // centered, else docked at the bottom of the chat column. While a switch
  // looks up the next session's workspace, the composer stays (disabled)
  // instead of unmounting; sending needs `workspace` itself.
  const composerElement = workspace || (isSessionLoading && chatOnScreen && storeWorkspace) ? (
    <ChatComposer
      composerRef={inputRef}
      placement={composerInline ? 'inline' : 'docked'}
      draftHandoff={draftHandoff}
      workspace={workspace}
      sessionId={sessionIdState}
      isDraft={isDraft}
      isSessionLoading={isSessionLoading}
      isAgentWorking={isAgentWorking}
      isPhone={isPhone}
      serverDown={serverDown}
      needsModelSetup={needsModelSetup}
      capabilities={leadCapabilities}
      interactionMode={sessionInteractionMode}
      pendingInteractionMode={sessionPendingInteractionMode}
      isSwitchingInteractionMode={isSwitchingInteractionMode}
      onInteractionModeChange={(mode) => {
        setIsSwitchingInteractionMode(true)
        void useAgentStore.getState().setSessionInteractionMode(mode).finally(() => {
          setIsSwitchingInteractionMode(false)
        })
      }}
      slashCommands={slashCommands}
      snippetCommands={snippetCommands}
      onSlashCommand={handleSlashCommand}
      onSnippetCommand={handleSnippetCommand}
      expandUserCommand={expandUserCommand}
      historyPrompts={historyPrompts}
      onDesignFeedbackRemoved={handleDesignFeedbackRemoved}
      onValueChange={handleDraftValueChange}
      fileRefs={fileRefs}
      onFileRefsNeeded={() => setFileRefsEnabled(true)}
      revertedCount={leadRevertedCount}
      revertedMessages={leadRevertedMessages}
      revertKeptFiles={revertKeepsFiles}
      runSettings={runSettings}
      tokens={headerTokens}
      sessionCostUsd={sessionCostUsd}
      hasVisibleBlocks={leadHasVisibleBlocks}
      hasLiveBlocks={leadHasLiveBlocks}
      sentFrom={sessionSentFrom}
      onOpenSession={handleOpenSession}
      onOpenSideQuestions={handleOpenSideQuestions}
      sideQuestionsInDock={dockViewsEnabled}
      sideQuestionsTabShown={dockViewsEnabled && workspacePanel !== null && dockActiveView === 'btw'}
    />
  ) : null

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // h-dvh handles iOS Safari's dynamic toolbar.
    <div
      className="mobile-safe-shell mobile-viewport flex h-dvh flex-col bg-(--bg-page)"
      data-chat-shell=""
      {...edgeSwipeHandlers}
      // Files dropped anywhere in the window (header, sidebar, dock) attach
      // to the composer, so this opts the whole shell out of the stray-drop
      // guard (usePreventStrayFileDrop). While the dock covers the chat the
      // composer is inert, so drops fall back to the guard.
      data-file-drop-zone={chatCoveredByDock ? undefined : ''}
      onDragEnter={chatCoveredByDock ? undefined : handleDragEnter}
      onDragOver={chatCoveredByDock ? undefined : handleDragOver}
      onDragLeave={chatCoveredByDock ? undefined : handleDragLeave}
      onDrop={chatCoveredByDock ? undefined : handleDrop}
    >
      {isDraggingFile && (
        <div className="pointer-events-none fixed inset-0 z-50 p-4 drag-overlay-enter">
          <div className="w-full h-full rounded-lg border-2 border-dashed border-(--color-accent)/30 bg-(--bg-card)/80 backdrop-blur-xs reduce-transparency:bg-(--bg-card) reduce-transparency:backdrop-blur-none flex flex-col items-center justify-center gap-2 drag-card-enter">
            <FileUp size={16} className="text-(--color-accent) oa-breathe" />
            <span className="text-sm font-medium text-(--color-text)">
              Drop files to attach
            </span>
          </div>
        </div>
      )}
      <ChatFrame
        phoneStack={phoneStack}
        // The Review panel and a file sheet cover the chat on a phone, and
        // close by their own swipe and Back first.
        backEnabled={workspacePanel === null && fileViewer === null}
        // 36 px header above the sidebar/content row. On macOS Tauri it
        // doubles as the window drag region via useTauriDrag, with a 70 px
        // left inset reserved for the OS traffic-lights.
        header={<AgentChatHeader
          dragHandlers={dragHandlers}
          isMacOverlay={isMacOverlay}
          isMobile={isMobile}
          workspace={workspace}
          chatWorkspace={chatWorkspace}
          workspaceTitle={headerLabel?.workspace}
          checkoutName={headerLabel?.checkout}
          sessionTitle={sessionTitle}
          onOpenLead={parentSessionId ? handleOpenLead : undefined}
          onSidebarToggle={handleSidebarToggle}
          onBack={phoneStack?.onBack}
          sessionId={sessionIdState}
          todos={todos}
          onToggleTasks={handleToggleTasks}
          tasksViewActive={dockViewsEnabled ? workspacePanel !== null && dockActiveView === 'tasks' : showTodos}
          goalState={headerGoalState}
          workspacePanel={workspacePanel}
          onWorkspaceFiles={handleWorkspaceFiles}
        />}
        // Beside the chat on desktop. A narrow window's drawer is
        // position:fixed and takes no room; a phone's is the Sessions screen.
        sidebar={<Sidebar
            currentSessionId={sessionIdState || undefined}
            workspace={workspace}
            draftWorkspace={sessionId ? null : workspace}
            onNewSession={handleNewSession}
            onCollapse={() => (sidebarDrawer ? setSidebarDrawerOpen(false) : setSidebarCollapsed(true))}
            openWorkspaceDialogKey={openWorkspaceDialogKey}
            searchSessionsKey={searchSessionsKey}
            desktopCollapsed={sidebarDrawer ? !sidebarDrawerOpen : sidebarCollapsed}
            drawer={sidebarDrawer}
            dockOpen={Boolean(workspace) && workspacePanel !== null}
            page={Boolean(phoneStack)}
            mobileOpen={phoneStack ? phoneStack.atSessions : mobileSidebarOpen}
            onOpenPalette={handleTogglePalette}
            onOpenScheduler={handleToggleScheduler}
            onOpenServers={phoneStack?.onBackToServers}
            onMobileClose={() => {
              setMobileSidebarOpen(false)
              setSidebarDrawerOpen(false)
            }}
        />}
        footer={<AppFooter
          workspace={workspace}
          chatWorkspace={isChatWorkspace}
          sessionId={sessionIdState}
          sessionFastMode={storeState.sessionFastMode}
          onOpenGitChanges={workspace && canOpenGit ? handleOpenGit : undefined}
        />}
      >
        {/* A crash in the chat or the Review panel shows in their place; the
            header, sidebar and status bar keep working. */}
        <ViewErrorBoundary resetKey={sessionIdState}>
        <div ref={centerRef} data-workbench-center="" className="relative flex min-w-0 flex-1 overflow-hidden">
        <main
          id="main"
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
          inert={chatCoveredByDock}
          aria-hidden={chatCoveredByDock || undefined}
          // The shell above handles the drop; the chat column stays a marked
          // drop zone so it is never mistaken for a stray drop target.
          data-file-drop-zone
        >
        <ConnectionBanner retry={!(!effectiveWorkspace && !isSessionLoading && serverDown)} />
        {findOpen && !isMobile && <TranscriptFind onClose={closeFind} />}
        {/* The draft screen carries its own setup card instead. */}
        {!isDraft && (
          <ProviderSetupNotice
            setupMessage={setupRequired?.message ?? null}
            hasConfiguredProvider={!needsModelSetup}
            missingProvider={modelReady.status === 'needs-provider' ? { label: modelReady.provider.label, model: modelReady.model } : null}
            onOpenProviders={() => openSettings('models')}
            onChooseModel={() => { if (!useUIStore.getState().runPickerOpen) handleToggleRunPicker() }}
            onDismiss={dismissSetupRequired}
          />
        )}
        {sessionId && workspace && folderMissing && (
          <MissingFolderBanner workspace={workspace} onOpenFolder={handleOpenWorkspaceDialog} />
        )}
        {sessionNotFound && !workspace ? (
          <SessionNotFound />
        ) : isSessionLoading && !chatOnScreen ? (
          <OpeningScreen
            title={isChatWorkspace ? 'Opening chat…' : 'Opening session…'}
            body={isChatWorkspace
              ? 'Loading this conversation.'
              : 'Loading the saved workspace for this session.'}
          />
        ) : workspace && agentRegistryLoading && !chatOnScreen ? (
          <OpeningScreen
            title={isChatWorkspace ? 'Opening chat…' : 'Opening workspace…'}
            body={isChatWorkspace ? 'Preparing Chat' : `Preparing agents for ${workspace}`}
          />
        ) : !effectiveWorkspace && !isSessionLoading && serverDown ? (
          <ServerUnreachable />
        ) : !effectiveWorkspace && !isSessionLoading ? (
          <NoWorkspace onOpenFolder={handleOpenWorkspaceDialog} />
        ) : isDraft && workspace ? (
          <NewSessionScreen
            workspace={workspace}
            workspaceName={workspaceName}
            isChat={isChatWorkspace}
            chatWorkspace={chatWorkspace}
            composer={composerInline ? composerElement : null}
            setup={(modelReady.status === 'needs-model' || modelReady.status === 'needs-provider') && providersData ? (
              <ModelSetupCard
                key={modelReady.status === 'needs-provider' ? modelReady.provider.id : 'needs-model'}
                readiness={modelReady}
                providers={providersData.providers}
                onOpenProviders={() => openSettings('models')}
              />
            ) : null}
            isMobile={isMobile}
            phone={isPhone}
            onSelectWorkspace={handleSelectDraftWorkspace}
            onOpenFolder={handleOpenWorkspaceDialog}
          />
        ) : (
          <>
          {/* Hand-off: an inert copy of the draft screen fades out over the
              incoming chat while the composer glides to the bottom. */}
          {draftHandoff.active && workspace && (
            <NewSessionScreen
              leaving
              workspace={workspace}
              workspaceName={workspaceName}
              isChat={isChatWorkspace}
              chatWorkspace={chatWorkspace}
              composerPlaceholderHeight={draftHandoff.snapshot?.rect.height}
              isMobile={isMobile}
              phone={isPhone}
              onSelectWorkspace={handleSelectDraftWorkspace}
              onOpenFolder={handleOpenWorkspaceDialog}
            />
          )}
          <motion.div
            // Opening a session whose workspace is still being looked up: the
            // chat on screen stays, for looking at only, until it is known.
            // A narrow window's Review panel covers it too.
            inert={isSessionLoading || transcriptCoveredByDock}
            aria-hidden={transcriptCoveredByDock || undefined}
            className="flex flex-1 flex-col min-h-0"
            initial={draftHandoff.active && !reducedMotion ? { opacity: 0, y: 8 } : false}
            animate={{ opacity: isSessionLoading ? 0.7 : 1, y: 0 }}
            transition={{ duration: DURATIONS_S.base, delay: 0.06, ease: EASINGS.out }}
          >
            <ActiveAgentView
              onMentionFileOpen={handleMentionFileOpen}
              onOpenSession={handleOpenSession}
              fileRefOpener={fileRefOpener}
              onRetry={handleRetry}
              onSwitchModel={handleSwitchModel}
              jumpToLatestInComposer={composerHoldsTray}
              emptyState={
                effectiveWorkspace ? (
                  <div className="flex flex-col items-center justify-center py-16">
                    <WorkspaceInfoCard
                      workspace={effectiveWorkspace}
                      chatWorkspace={isChatWorkspace}
                      currentSessionId={sessionIdState}
                    />
                  </div>
                ) : undefined
              }
            />
          </motion.div>
          </>
        )}

        {parentSessionId ? (
          <div className="mx-auto w-full max-w-3xl px-4 py-3">
            {/* Phones wrap the sentence and drop the button under it, rather
                than truncating the explanation to a few words. */}
            <div data-subagent-banner="" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-4 py-2 text-xs text-(--color-text-muted) sm:flex-nowrap">
              <div className="flex min-w-0 items-start gap-2 sm:items-center">
                <span className="shrink-0 rounded-xs bg-(--bg-key)/60 px-1.5 py-0.5 font-mono text-meta font-semibold text-(--color-text)">
                  {leadName}
                </span>
                <span className="sm:truncate">The main agent directs this subagent. Open the main agent's session to send instructions.</span>
              </div>
              <Button
                size="xs"
                variant="default"
                onClick={handleOpenLead}
                className="shrink-0"
              >
                Return to main agent
              </Button>
            </div>
          </div>
        ) : composerInline ? null : composerElement}
        </main>
        {/* Review dock — only with a workspace attached.
            Desktop: in-flow sibling sized as a ratio of this center region,
            or an overlay across it when maximized / the window is narrow.
            Mobile: fixed full-screen overlay from the right. */}
        <AnimatePresence initial={false}>
          {workspace && (dockOpen || dockKept) && (
            <WorkspacePanel
              key="review-dock"
              workspace={workspace}
              open={dockOpen}
              slideIn={dockSlidesIn}
              chatWorkspace={isChatWorkspace}
              mobile={isMobile}
              centerRef={centerRef}
              selectedFilePath={fileViewer?.path ?? null}
              selectedFileOpenKey={fileOpenKey}
              terminalOpenKey={terminalOpenKey}
              handledTerminalOpenKeyRef={handledTerminalOpenKeyRef}
              terminalRunRequest={terminalRunRequest}
              handledTerminalRunKeyRef={handledTerminalRunKeyRef}
              viewRequest={dockViewRequest}
              handledViewRequestKeyRef={handledDockViewKeyRef}
              diffRequest={dockDiffRequest}
              handledDiffRequestKeyRef={handledDockDiffRequestKeyRef}
              previewRequest={dockPreviewRequest}
              handledPreviewRequestKeyRef={handledDockPreviewRequestKeyRef}
              attachmentRequest={dockAttachmentRequest}
              handledAttachmentRequestKeyRef={handledDockAttachmentRequestKeyRef}
              layoutRequest={dockLayoutRequest}
              handledLayoutRequestKeyRef={handledDockLayoutKeyRef}
              launcherFocusKey={dockLauncherFocusKey}
              handledLauncherFocusKeyRef={handledDockLauncherFocusKeyRef}
              onSendPreviewComments={handleSendPreviewComments}
              onActiveViewChange={setDockActiveView}
              todos={todos}
              sessionId={sessionIdState}
              plan={plan}
              onClearPlan={handleClearPlan}
              onFileSelect={handleFileSelect}
              onAddComment={handleAddFileComment}
              onRequestClose={() => setWorkspacePanel(null)}
            />
          )}
        </AnimatePresence>
        </div>
        </ViewErrorBoundary>
      </ChatFrame>

      <AgentChatPanels
        showTodos={!dockViewsEnabled && showTodos}
        onShowTodosChange={handleSetShowTodos}
        todos={todos}
        goal={goal}
        onGoalAction={goalControls}
        plan={plan}
        onClearPlan={handleClearPlan}
        onOpenPlan={workspace ? handleOpenPlan : undefined}
        onOpenGoal={workspace ? handleOpenGoal : undefined}
        schedulerOpen={schedulerOpen}
        onCloseScheduler={closeScheduler}
        showPalette={paletteOpen}
        palettePage={palettePage}
        paletteKey={paletteKey}
        paletteCommands={paletteCommands}
        sessionId={sessionIdState}
        quickOpenOpen={quickOpenOpen}
        quickOpenQuery={quickOpenQuery}
        quickOpenWorkspaceFiles={quickOpenWorkspaceFiles}
        quickOpenFilesTruncated={quickOpenFilesTruncated}
        quickOpenFilesLoading={quickOpenFilesLoading}
        onQuickOpenFileOpen={workspace ? handleQuickOpenFileOpen : undefined}
        onClosePalette={closePalette}
        onCloseQuickOpen={closeQuickOpen}
      />
    </div>
  )
}
