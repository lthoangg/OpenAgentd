/**
 * AgentChatView — top-level layout for the agent chat route.
 *
 * Owns:
 *   - Side panels (``Sidebar``, ``WorkspaceFilesPanel``, ``SessionSettingsPanel``,
 *     todos popover, command palette).
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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useNavigate } from '@tanstack/react-router'
import { AgentView } from '../AgentView'
import type { OpenSessionHandler } from '../AgentView/UserBubble'
import type { FileRefOpener } from '../FileRefLink'
import { WorkspaceInfoCard } from '../WorkspaceInfoCard'
import { NewSessionScreen } from '../NewSession/NewSessionScreen'
import { ModelSetupCard } from '../NewSession/ModelSetupCard'
import { startNewSession } from '@/lib/new-session'
import { Sidebar } from '../Sidebar'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useClearSessionPlanMutation, useSessionPlanQuery } from '@/queries/useSessionPlanQuery'
import { useProvidersQuery } from '@/queries'
import { modelReadiness } from '@/lib/model-readiness'
import { isChatWorkspacePath, useChatWorkspace } from '@/queries/useChatWorkspace'
import { useAgentStore, isAwaitingRestartOutput } from '@/stores/useAgentStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/stores/useUIStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useMarkSessionRead } from '@/stores/useUnreadStore'
import { useReportShownSession } from '@/lib/island-setting'
import { useElementWidthSelect } from '@/hooks/use-element-width'
import { settledWidthBesidePanels } from '@/components/ResizableAside'
import { isFocusStranded, useReturnFocusFromDock, useStrandedFocusGuard } from '@/hooks/use-dock-focus'
import { dockOverlaysChat } from '@/lib/workbench-layout'
import { lastPreviewUrl, previewsAvailable } from '@/api/preview'
import { OPEN_PREVIEW_EVENT, isPreviewTarget } from '../Preview/preview-events'
import type { DesignFeedback } from '@/lib/design-feedback'
import { useReturnedFeedbackStore } from '@/stores/useReturnedFeedbackStore'
import { previewTargetForFeedback } from '../Preview/preview-comments'
import { usePreviewToolAutoOpen } from './usePreviewToolAutoOpen'
import { useToastStore } from '@/stores/useToastStore'
import { selectBtw, useBtwStore } from '@/stores/useBtwStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useAgentsQuery } from '@/queries/useAgentsQuery'
import { useRegistryQuery } from '@/queries/useAgentSettingsQueries'
import { useFileRefsQuery } from '@/queries/useFileRefsQuery'
import { FolderCode, FileUp } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { useTauriDrag } from '@/hooks/use-tauri-drag'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { type InputComposerHandle } from '../InputComposer'
import { FloatingInputComposer } from '../FloatingInputComposer'
import { BtwPanel } from '../BtwPanel'
import { AppFooter } from '../AppFooter'
import { WorkspacePanel } from '../WorkspacePanel'
import { saveLastWorkspace, workspaceLabel } from '@/utils/workspace'
import { OPEN_SESSION_EVENT, isOpenSessionRequest } from '@/utils/workspace-messages'
import { workspaceRelativePath } from '@/utils/file-refs'
import type {
  AgentCapabilities as AgentCapabilitiesType,
  ContentBlock,
  MessageAttachment,
} from '@/api/types'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { AgentChatHeader } from './AgentChatHeader'
import { AgentChatPanels } from './AgentChatPanels'
import { ProviderSetupNotice } from './ProviderSetupNotice'
import { retryLatestPrompt } from './retryPrompt'
import { useDragDrop } from './useDragDrop'
import { useOverlayState } from './useOverlayState'
import { useSessionBootstrap } from './useSessionBootstrap'
import { useDraftHandoff } from './useDraftHandoff'
import { useSlashCommands } from './useSlashCommands'
import { useCommandPalette } from './useCommandPalette'
import { btwSubmit, composerHistoryPrompts, newestUserBlockId, parseBuiltInSlashCommand } from './helpers'
import { deliverFromComposer, stopTurn, useReleaseHeldMessages } from './heldMessages'

type RevertedMessage = { role: string; content: string; attachments?: MessageAttachment[] }
const EMPTY_BLOCKS: ContentBlock[] = []
const EMPTY_REVERTED_MESSAGES: RevertedMessage[] = []

const isInReviewDock = (element: Element) => element.closest('[data-review-dock]') !== null
/** Stable selector: the shell only needs to know when the split stops fitting. */
const isCenterTooNarrow = (width: number) => dockOverlaysChat(width, false)

interface ActiveAgentViewProps {
  emptyState?: React.ReactNode
  onMentionFileOpen?: (path: string) => void
  onOpenSession?: OpenSessionHandler
  fileRefOpener?: FileRefOpener
  onRetry?: () => void
  onSwitchModel?: () => void
  /** The floating composer is up and carries the jump-to-latest chip. */
  jumpToLatestInComposer?: boolean
}

const ActiveAgentView = memo(function ActiveAgentView({
  emptyState,
  onMentionFileOpen,
  onOpenSession,
  fileRefOpener,
  onRetry,
  onSwitchModel,
  jumpToLatestInComposer,
}: ActiveAgentViewProps) {
  const activeStream = useAgentStore((s) => {
    if (s.leadName && s.agentStreams[s.leadName]) return s.agentStreams[s.leadName]
    return Object.values(s.agentStreams)[0]
  })

  const activeBlocks = activeStream?.blocks ?? EMPTY_BLOCKS
  const activeCurrentBlocks = activeStream?.currentBlocks ?? EMPTY_BLOCKS
  const activeStatus = activeStream?.status ?? 'idle'
  const activeLastError = activeStream?.lastError ?? null
  const activeAwaitingRestart = isAwaitingRestartOutput(activeStream)

  return (
    <AgentView
      blocks={activeBlocks}
      currentBlocks={activeCurrentBlocks}
      isWorking={activeStatus === 'working'}
      isTurnOpen={activeStatus === 'working' || activeStatus === 'waiting_input'}
      isAwaitingRestart={activeAwaitingRestart}
      isError={activeStatus === 'error'}
      lastError={activeLastError}
      onMentionFileOpen={onMentionFileOpen}
      onOpenSession={onOpenSession}
      fileRefOpener={fileRefOpener}
      emptyState={emptyState}
      onRetry={onRetry}
      onSwitchModel={onSwitchModel}
      jumpToLatestInComposer={jumpToLatestInComposer}
    />
  )
})

interface AgentChatViewProps {
  sessionId?: string
  workspace?: string | null
  sessionLoading?: boolean
}

export function AgentChatView({ sessionId, workspace = null, sessionLoading = false }: AgentChatViewProps) {
  const navigate = useNavigate()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const pushToast = useToastStore((s) => s.push)
  const isMobile = useIsMobile()
  const { isMacOverlay } = usePlatform()
  const storeWorkspace = useAgentStore((s) => s._workspace)
  const effectiveWorkspace = workspace || storeWorkspace
  // Chat sessions run on the same screen as project workspaces but the root is
  // not a repository: labels read "Chat" and the dock has no Git tab.
  const chatWorkspace = useChatWorkspace()
  const isChatWorkspace = isChatWorkspacePath(effectiveWorkspace, chatWorkspace)
  const workspaceName = effectiveWorkspace ? workspaceLabel(effectiveWorkspace, chatWorkspace) : ''
  // Manual drag pattern: a mousedown handler that only starts a drag
  // when the user pressed on the bare header, not on a child button.
  // The hook returns `{}` outside Tauri so the spread is a no-op in
  // browsers. See ``useTauriDrag`` for details.
  const dragHandlers = useTauriDrag()
  const inputRef = useRef<InputComposerHandle>(null)
  const mainColumnRef = useRef<HTMLDivElement>(null)
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
        beginResolvedSession: s.beginResolvedSession,
        consumeResolvedSessionReady: s.consumeResolvedSessionReady,
        setSessionModelSettings: s.setSessionModelSettings,
        setupRequired: s.setupRequired,
        dismissSetupRequired: s.dismissSetupRequired,

        isAgentWorking: s.isAgentWorking,
        sessionId: s.sessionId,
        parentSessionId: s.parentSessionId,
        leadName: s.leadName,
        sessionTitle: s.sessionTitle,
        sessionInteractionMode: s.sessionInteractionMode,
        sessionPendingInteractionMode: s.sessionPendingInteractionMode,
        sessionModel: s.sessionModel,
        sessionThinkingLevel: s.sessionThinkingLevel,
        sessionFastMode: s.sessionFastMode,

        leadRevertedCount: leadStream?.revertedCount ?? 0,
        leadRevertedMessages: leadStream?.revertedMessages ?? EMPTY_REVERTED_MESSAGES,
        leadHasVisibleBlocks: (leadStream?.blocks.length ?? 0) > 0,
        leadHasLiveBlocks: (leadStream?.currentBlocks.length ?? 0) > 0,

        leadPromptTokens: leadStream?.usage.promptTokens ?? 0,
        leadCompletionTokens: leadStream?.usage.completionTokens ?? 0,
        leadCachedTokens: leadStream?.usage.cachedTokens ?? 0,
        leadCachedPercent: leadStream?.usage.cachedPercent,
        sessionCostUsd: Math.round(s.agentNames.reduce(
          (total, name) => total + (s.agentStreams[name]?.usage.estimatedCostUsd ?? 0),
          0,
        ) * 1e8) / 1e8,
      }
    })
  )

  const {
    connectStream,
    loadAgentStatus,
    loadSession,
    beginResolvedSession,
    consumeResolvedSessionReady,
    setSessionModelSettings,
    setupRequired,
    dismissSetupRequired,

    isAgentWorking,
    sessionId: sessionIdState,
    parentSessionId,
    leadName,
    sessionTitle,
    sessionInteractionMode,
    sessionPendingInteractionMode,
    sessionModel,
    sessionThinkingLevel,

    leadRevertedCount,
    leadRevertedMessages,
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
  const agentCapabilitiesOpen = useUIStore((s) => s.agentCapabilitiesOpen)
  const paletteOpen = useUIStore((s) => s.paletteOpen)
  const palettePage = useUIStore((s) => s.palettePage)
  const paletteKey = useUIStore((s) => s.paletteKey)
  const quickOpenOpen = useUIStore((s) => s.quickOpenOpen)
  const quickOpenQuery = useUIStore((s) => s.quickOpenQuery)
  const toggleScheduler = useUIStore((s) => s.toggleScheduler)
  const toggleAgentCapabilities = useUIStore((s) => s.toggleAgentCapabilities)
  const togglePalette = useUIStore((s) => s.togglePalette)
  const toggleQuickOpen = useUIStore((s) => s.toggleQuickOpen)
  const closeScheduler = useUIStore((s) => s.closeScheduler)
  const closeAgentCapabilities = useUIStore((s) => s.closeAgentCapabilities)
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
    dockViewRequest,
    handledDockViewKeyRef,
    dockDiffRequest,
    handledDockDiffRequestKeyRef,
    dockPreviewRequest,
    handledDockPreviewRequestKeyRef,
    dockAttachmentRequest,
    handledDockAttachmentRequestKeyRef,
    handleOpenAttachment,
    handleOpenPreview,
    dockActiveView,
    setDockActiveView,
    dockViewsEnabled,
    sidebarCollapsed,
    setSidebarCollapsed,
    openWorkspaceDialogKey,
    showTodos,
    showMobileActions,
    handleWorkspaceFiles,
    handleOpenGit,
    handleSidebarToggle,
    handleOpenWorkspaceDialog,
    handleFileSelect,
    handleMentionFileOpen,
    handleFileRefOpen,
    handleDiffOpen,
    closeMobileActionsMenu,
    handleSetShowMobileActions,
    handleToggleAgentCapabilities,
    handleToggleScheduler,
    handleTogglePalette,
    handleSwitchModel,
    handleToggleQuickOpen,
    handleSetShowTodos,
    handleToggleTasks,
    handleOpenPlan,
    handleOpenSideQuestions,
    handleOpenTerminal,
    edgeSwipeHandlers,
    sidebarDragOffset,
    actionsDragOffset,
    workspacePanelDragOffset,
  } = useOverlayState({
    isMobile,
    workspace,
    toggleScheduler,
    toggleAgentCapabilities,
    togglePalette,
    toggleQuickOpen,
  })

  // The other end of a workspace message: the sender's session from the
  // request's chip, the replier's session from a reply report.
  const handleOpenSession = useCallback((targetSessionId: string, targetWorkspace: string) => {
    if (targetWorkspace) saveLastWorkspace(targetWorkspace)
    navigate({ to: '/$sessionId', params: { sessionId: targetSessionId } })
  }, [navigate])
  // The ``workspace`` tool card asks for the same switch by event,
  // which keeps ToolCall free of the router.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const request = (event as CustomEvent<unknown>).detail
      if (isOpenSessionRequest(request)) handleOpenSession(request.sessionId, request.workspace)
    }
    window.addEventListener(OPEN_SESSION_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SESSION_EVENT, onOpen)
  }, [handleOpenSession])

  const leadBlocks = useAgentStore((s) => (
    s.leadName ? s.agentStreams[s.leadName]?.blocks ?? EMPTY_BLOCKS : EMPTY_BLOCKS
  ))
  const historyPrompts = useMemo(() => composerHistoryPrompts(leadBlocks), [leadBlocks])
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

  const { data: todosData } = useTodosQuery(sessionIdState)
  const btwOpen = useBtwStore((s) => selectBtw(sessionIdState)(s).open)
  const todos = todosData?.todos ?? []
  const { data: planData } = useSessionPlanQuery(sessionIdState)
  const plan = planData?.plan ?? null
  const planAwaitingReview = useAgentStore((s) => s.pendingQuestion?.kind === 'plan_review')
  const { mutate: clearPlan } = useClearSessionPlanMutation()
  const handleClearPlan = useCallback(() => {
    if (!sessionIdState) return
    clearPlan(sessionIdState, {
      onError: (err) => pushToast({ tone: 'error', title: 'Could not clear the plan', description: err instanceof Error ? err.message : String(err) }),
    })
  }, [sessionIdState, clearPlan, pushToast])
  const providersQ = useProvidersQuery()

  // Lead capabilities — used to drive composer affordances (slash menu).
  const agentWorkspace = workspace
  const hasWorkspace = Boolean(workspace)
  const isSessionLoading = sessionLoading
  const { data: agentRegistryData, isLoading: agentRegistryLoading } = useAgentsQuery(agentWorkspace, hasWorkspace)
  const leadAgent = agentRegistryData?.agents?.[0]
  const leadCapabilities: AgentCapabilitiesType | undefined = leadAgent?.capabilities
  // Can a message run? A real model whose provider is connected. Unknown
  // while either list loads, so no setup prompt flashes on a working setup.
  const modelReady = modelReadiness(
    providersQ.data?.providers,
    agentRegistryData ? (sessionModel || leadAgent?.model || null) : undefined,
  )
  const needsModelSetup = modelReady.status === 'needs-model' || modelReady.status === 'needs-provider'

  // When the session overrides the agent's model (e.g. user switches from
  // model A to model B mid-session), the trigger threshold must reflect the
  // *active* model, not the agent config model.  Look up the session model in
  // the registry; fall back to the lead agent's pre-computed value.
  const { data: registryData } = useRegistryQuery()
  const summaryTriggerTokens = useMemo(() => {
    if (sessionModel) {
      const entry = registryData?.models?.find((m) => m.id === sessionModel)
      if (entry?.summary_trigger_tokens) return entry.summary_trigger_tokens
    }
    return leadAgent?.summary_trigger_tokens
  }, [sessionModel, registryData, leadAgent])
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
    sessionCostUsd,
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

  const handleOpenNewPreview = useCallback(() => {
    if (!workspace) return
    handleOpenPreview({ kind: 'url', url: lastPreviewUrl(workspace) ?? 'http://localhost:5173' })
  }, [handleOpenPreview, workspace])

  const handleSendPreviewComments = useCallback((feedback: DesignFeedback) => {
    inputRef.current?.addDesignFeedback(feedback)
    inputRef.current?.focus()
  }, [])

  // A feedback chip's x sends its comments back to their Preview tab's list,
  // opening that tab on desktop (it picks them up whenever it next mounts).
  const handleDesignFeedbackRemoved = useCallback((feedback: DesignFeedback) => {
    if (!workspace) return
    useReturnedFeedbackStore.getState().give({ workspace, feedback })
    const target = previewTargetForFeedback(feedback)
    if (target && !isMobile && previewsAvailable()) handleOpenPreview(target, { focusOnly: true })
  }, [handleOpenPreview, isMobile, workspace])

  // The `preview` tool card's Open button, and the agent opening a page
  // (desktop only: phones keep the chat on screen).
  useEffect(() => {
    const onOpen = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail
      if (isPreviewTarget(target)) handleOpenPreview(target)
    }
    window.addEventListener(OPEN_PREVIEW_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_PREVIEW_EVENT, onOpen)
  }, [handleOpenPreview])
  usePreviewToolAutoOpen({ enabled: !isMobile && Boolean(workspace) && previewsAvailable(), onOpen: handleOpenPreview })

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
    onOpenSideQuestions: handleOpenSideQuestions,
  })

  useReleaseHeldMessages({ workspace, sessionId: sessionIdState, composerRef: inputRef })
  useMarkSessionRead(sessionIdState)
  useReportShownSession(sessionIdState)

  // ``/btw <question>``: a side question, never sent to the chat; a bare
  // ``/btw`` shows them again. Either shows the dock's BTW tab on desktop
  // with a workspace, else the panel above the composer. Returns false when
  // ``content`` is not one.
  // The composer clears itself right after submit, so a refused draft is
  // put back on the next task.
  const handleBtwSubmit = useCallback((content: string, files?: File[]): boolean => {
    const action = btwSubmit(content, files, sessionIdState)
    const giveBack = () => setTimeout(() => {
      inputRef.current?.setValue(content)
      if (files?.length) inputRef.current?.setFiles(files)
    }, 0)
    switch (action.kind) {
      case 'not-btw':
        return false
      case 'no-session':
        pushToast({ tone: 'info', title: 'Start a conversation first', description: 'Side questions answer from what the session already holds.' })
        giveBack()
        break
      case 'attachments':
        pushToast({ tone: 'error', title: 'Side questions can’t include attachments', description: 'Remove the files, or send them as a normal message.' })
        giveBack()
        break
      case 'reopen':
        if (sessionIdState) handleOpenSideQuestions(sessionIdState)
        break
      case 'ask':
        if (!sessionIdState) break
        void useBtwStore.getState().ask(sessionIdState, action.question)
        handleOpenSideQuestions(sessionIdState)
        break
    }
    return true
  }, [sessionIdState, pushToast, handleOpenSideQuestions])

  const {
    paletteCommands,
    quickOpenWorkspaceFiles,
    quickOpenFilesTruncated,
    handleQuickOpenFileOpen,
  } = useCommandPalette({
    workspace,
    quickOpenOpen,
    sessionIdState,
    workspacePanelOpen: workspacePanel !== null,
    handleNewSession,
    handleWorkspaceFiles,
    handleOpenGit: workspace && !isChatWorkspace ? handleOpenGit : undefined,
    handleSidebarToggle,
    handleToggleAgentCapabilities,
    handleToggleTasks,
    handleTogglePalette,
    handleToggleQuickOpen,
    handleToggleScheduler,
    handleOpenTerminal,
    handleOpenPlan: plan || planAwaitingReview ? handleOpenPlan : undefined,
    planAwaitingReview,
    handleOpenPreview: workspace && previewsAvailable() ? handleOpenNewPreview : undefined,
    handleOpenSideQuestions,
    setFileViewer,
    setFileOpenKey,
    setWorkspacePanel,
  })

  // Review dock geometry: a ratio of the center region (chat + dock), with a
  // maximized / narrow-window overlay that covers the chat instead of
  // squeezing it. The chat stays mounted underneath so its scroll position
  // and live stream survive a maximize round-trip. The dock measures the
  // center itself; the shell subscribes to one bit so a sidebar tween or a
  // window drag does not re-render this whole tree every frame.
  const centerRef = useRef<HTMLDivElement>(null)
  const centerTooNarrow = useElementWidthSelect(centerRef, isCenterTooNarrow, settledWidthBesidePanels)
  const dockMaximized = useLayoutStore((s) => s.dockMaximized)
  // After its first open the dock stays mounted, closed or not, so its tabs
  // and their live content (preview pages, unsent comments) survive a close.
  const dockOpen = workspacePanel !== null
  const [dockKept, setDockKept] = useState(dockOpen)
  if (dockOpen && !dockKept) setDockKept(true)
  const chatCoveredByDock = !isMobile && Boolean(workspace) && workspacePanel !== null && (dockMaximized || centerTooNarrow)
  // The dock claims focus while it covers the chat; give it back when it
  // closes or uncovers the chat so it is never left on <body>.
  useReturnFocusFromDock({
    open: workspacePanel !== null,
    covered: chatCoveredByDock,
    enabled: !isMobile,
    isInDock: isInReviewDock,
    onReturn: returnFocusToComposer,
  })
  // A desktop app always has a focused control: never leave focus on
  // <body>, and start in the composer once a session is on screen.
  useStrandedFocusGuard(!isMobile, returnFocusToComposer)
  useEffect(() => {
    if (isMobile || isSessionLoading || typeof document === 'undefined') return
    if (document.hasFocus() && isFocusStranded()) returnFocusToComposer()
  }, [isMobile, isSessionLoading, sessionIdState, returnFocusToComposer])

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

  // One composer element: inside the new-session screen while that is
  // centered, else docked/floating at the bottom of the chat column.
  // While a switch looks up the next session's workspace, the composer stays
  // (disabled) instead of unmounting; sending needs `workspace` itself.
  const composerElement = workspace || (isSessionLoading && chatOnScreen && storeWorkspace) ? (
    <FloatingInputComposer
      ref={inputRef}
      boundsRef={mainColumnRef}
      placement={composerInline ? 'inline' : 'floating'}
      onHandoffCapture={draftHandoff.capture}
      enterFrom={draftHandoff.active ? draftHandoff.snapshot : null}
      onSubmit={async (content, files, mentions, delivery) => {
        if (!workspace) return
        if (handleBtwSubmit(content, files)) return
        if (!files || files.length === 0) {
          const builtInCmd = parseBuiltInSlashCommand(content)
          if (builtInCmd) {
            handleSlashCommand(builtInCmd)
            return
          }
        }
        const expanded = await expandUserCommand(content)
        await deliverFromComposer(workspace, inputRef.current, { content: expanded, files, mentions }, delivery)
      }}
      onStop={() => { void stopTurn(inputRef.current) }}
      onSlashCommand={handleSlashCommand}
      onSnippetCommand={handleSnippetCommand}
      slashCommands={slashCommands}
      snippetCommands={snippetCommands}
      historyPrompts={historyPrompts}
      onHistoryRecall={handleHistoryRecall}
      onDesignFeedbackRemoved={handleDesignFeedbackRemoved}
      onValueChange={handleDraftValueChange}
      fileRefs={fileRefs}
      onFileRefsNeeded={() => setFileRefsEnabled(true)}
      isStreaming={isAgentWorking}
      disabled={isSessionLoading}
      placeholder={
        // While a turn runs the composer shows its own queue/stop hint.
        isDraft && needsModelSetup
          ? 'Connect a model to start chatting'
          : isChatWorkspace ? 'Ask anything…' : `Ask anything in ${workspaceName}…`
      }
      capabilities={leadCapabilities}
      // A switch requested mid-turn is queued server-side, so the toggle
      // shows what the user picked while the turn finishes under the old
      // mode.
      interactionMode={sessionPendingInteractionMode ?? sessionInteractionMode}
      interactionModePending={sessionPendingInteractionMode !== null}
      onInteractionModeChange={(mode) => {
        setIsSwitchingInteractionMode(true)
        void useAgentStore.getState().setSessionInteractionMode(mode).finally(() => {
          setIsSwitchingInteractionMode(false)
        })
      }}
      // The new-session draft picks a mode locally; the first message carries it.
      interactionModeDisabled={isSwitchingInteractionMode || (!sessionIdState && !isDraft)}
      revertedCount={leadRevertedCount}
      revertedMessages={leadRevertedMessages}
      onRedo={() => { void handleSlashCommand('redo') }}
      onRedoAll={() => { void handleSlashCommand('redo-all') }}
      // Desktop with a workspace: the dock's BTW tab shows side
      // questions, and here only the chip reopens it while that tab is
      // not on screen.
      aboveComposer={dockViewsEnabled && workspacePanel !== null && dockActiveView === 'btw' ? null : (
        <BtwPanel
          sessionId={sessionIdState || null}
          countEnabled={leadHasVisibleBlocks}
          chipOnly={dockViewsEnabled}
          onReopen={dockViewsEnabled && sessionIdState ? () => handleOpenSideQuestions(sessionIdState) : undefined}
        />
      )}
      aboveComposerOpen={btwOpen && !dockViewsEnabled}
    />
  ) : null

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // h-dvh handles iOS Safari's dynamic toolbar.
    <div
      className="mobile-safe-shell mobile-viewport flex h-dvh flex-col bg-(--bg-page)"
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
            <FileUp size={24} className="text-(--color-accent) animate-pulse" />
            <span className="text-sm font-medium text-(--color-text)">
              Drop files to attach
            </span>
          </div>
        </div>
      )}
      {/* 36 px header above the sidebar/content row. On macOS Tauri it
          doubles as the window drag region via useTauriDrag, with a
          70 px left inset reserved for the OS traffic-lights. */}
        <AgentChatHeader
          dragHandlers={dragHandlers}
          isMacOverlay={isMacOverlay}
          isMobile={isMobile}
          workspace={workspace}
          chatWorkspace={chatWorkspace}
          sessionTitle={sessionTitle}
          onSidebarToggle={handleSidebarToggle}
          headerTokens={headerTokens}
          sessionId={sessionIdState}
          todos={todos}
          onToggleTasks={handleToggleTasks}
          tasksViewActive={dockViewsEnabled ? workspacePanel !== null && dockActiveView === 'tasks' : showTodos}
          workspacePanel={workspacePanel}

        onWorkspaceFiles={handleWorkspaceFiles}
        agentCapabilitiesOpen={agentCapabilitiesOpen}
        onToggleAgentCapabilities={handleToggleAgentCapabilities}
        showMobileActions={showMobileActions}
        setShowMobileActions={handleSetShowMobileActions}
        mobileActionsDragOffset={actionsDragOffset}
        onToggleScheduler={handleToggleScheduler}
        onOpenTerminal={workspace && !isChatWorkspace ? handleOpenTerminal : undefined}
        onCloseMobileActionsMenu={closeMobileActionsMenu}
        onOpenPalette={handleTogglePalette}
        onQuickOpen={workspace ? handleToggleQuickOpen : undefined}
      />

      {/* Body row — sidebar + main content column. On
          mobile the Sidebar is position:fixed (overlay drawer), so it
          takes no space here and the main column is always full-width. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
            currentSessionId={sessionIdState || undefined}
            workspace={workspace}
            draftWorkspace={sessionId ? null : workspace}
            onCollapse={() => setSidebarCollapsed(true)}
            openWorkspaceDialogKey={openWorkspaceDialogKey}
            onCommandPalette={handleTogglePalette}
            desktopCollapsed={sidebarCollapsed}
            mobileOpen={mobileSidebarOpen}
            mobileDragOffset={sidebarDragOffset}
            onMobileClose={() => setMobileSidebarOpen(false)}
        />

        <div ref={centerRef} className="relative flex min-w-0 flex-1 overflow-hidden">
        <main
          id="main"
          ref={mainColumnRef}
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
          inert={chatCoveredByDock}
          aria-hidden={chatCoveredByDock || undefined}
          // The shell above handles the drop; the chat column stays a marked
          // drop zone so it is never mistaken for a stray drop target.
          data-file-drop-zone
        >
        <ConnectionBanner />
        {/* The draft screen carries its own setup card instead. */}
        {!isDraft && (
          <ProviderSetupNotice
            setupMessage={setupRequired?.message ?? null}
            hasConfiguredProvider={!needsModelSetup}
            onOpenProviders={() => openSettings('providers')}
            onDismiss={dismissSetupRequired}
          />
        )}
        {isSessionLoading && !chatOnScreen ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
            <div>
              <h2 className="text-sm font-medium text-(--color-text)">
                {isChatWorkspace ? 'Opening chat…' : 'Opening session…'}
              </h2>
              <p className="mt-1 text-xs text-(--color-text-muted)">
                {isChatWorkspace
                  ? 'Loading this conversation.'
                  : 'Loading the saved workspace for this session.'}
              </p>
            </div>
          </div>
        ) : workspace && agentRegistryLoading && !chatOnScreen ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
            <div>
              <h2 className="text-sm font-medium text-(--color-text)">
                {isChatWorkspace ? 'Opening chat…' : 'Opening workspace…'}
              </h2>
              <p className="mt-1 text-xs text-(--color-text-muted)">
                {isChatWorkspace ? 'Preparing Chat' : `Preparing agents for ${workspace}`}
              </p>
            </div>
          </div>
        ) : !effectiveWorkspace && !isSessionLoading ? (
          <EmptyState
            icon={FolderCode}
            title="No workspace attached"
            body="Choose a local project folder from the sidebar to start a session."
            action={
              <Button type="button" onClick={handleOpenWorkspaceDialog}>
                Open workspace
              </Button>
            }
          />
        ) : isDraft && workspace ? (
          <NewSessionScreen
            workspace={workspace}
            workspaceName={workspaceName}
            isChat={isChatWorkspace}
            chatWorkspace={chatWorkspace}
            composer={composerInline ? composerElement : null}
            setup={(modelReady.status === 'needs-model' || modelReady.status === 'needs-provider') && providersQ.data ? (
              <ModelSetupCard
                key={modelReady.status === 'needs-provider' ? modelReady.provider.id : 'needs-model'}
                readiness={modelReady}
                providers={providersQ.data.providers}
                onOpenProviders={() => openSettings('providers')}
              />
            ) : null}
            isMobile={isMobile}
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
              onSelectWorkspace={handleSelectDraftWorkspace}
              onOpenFolder={handleOpenWorkspaceDialog}
            />
          )}
          <motion.div
            // Opening a session whose workspace is still being looked up: the
            // chat on screen stays, for looking at only, until it is known.
            inert={isSessionLoading}
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
              jumpToLatestInComposer={!parentSessionId && Boolean(workspace)}
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
            <div className="flex items-center justify-between gap-3 rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-4 py-2 text-xs text-(--color-text-muted)">
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0 rounded-xs bg-(--bg-key)/60 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-(--color-text)">
                  {leadName}
                </span>
                <span className="truncate">Subagents are orchestrated by the lead agent. Switch to the lead session to send instructions.</span>
              </div>
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  if (parentSessionId) {
                    navigate({ to: '/$sessionId', params: { sessionId: parentSessionId } })
                  }
                }}
                className="shrink-0"
              >
                Return to Lead
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
              chatWorkspace={isChatWorkspace}
              mobile={isMobile}
              mobileDragOffset={workspacePanelDragOffset}
              centerRef={centerRef}
              selectedFilePath={fileViewer?.path ?? null}
              selectedFileOpenKey={fileOpenKey}
              terminalOpenKey={terminalOpenKey}
              handledTerminalOpenKeyRef={handledTerminalOpenKeyRef}
              viewRequest={dockViewRequest}
              handledViewRequestKeyRef={handledDockViewKeyRef}
              diffRequest={dockDiffRequest}
              handledDiffRequestKeyRef={handledDockDiffRequestKeyRef}
              previewRequest={dockPreviewRequest}
              handledPreviewRequestKeyRef={handledDockPreviewRequestKeyRef}
              attachmentRequest={dockAttachmentRequest}
              handledAttachmentRequestKeyRef={handledDockAttachmentRequestKeyRef}
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
      </div>

      <AppFooter
        workspace={workspace}
        chatWorkspace={isChatWorkspace}
        sessionId={sessionIdState}
        sessionModel={sessionModel}
        defaultModel={leadAgent?.model ?? null}
        defaultThinkingLevel={leadAgent?.thinking_level ?? null}
        sessionThinkingLevel={sessionThinkingLevel}
        sessionFastMode={storeState.sessionFastMode}
        onToggleSessionSettings={handleToggleAgentCapabilities}
        onOpenGitChanges={workspace && !isChatWorkspace ? handleOpenGit : undefined}
      />

      <AgentChatPanels
        agentCapabilitiesOpen={agentCapabilitiesOpen}
        agentWorkspace={agentWorkspace}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        onSessionModelSettingsChange={setSessionModelSettings}
        onCloseAgentCapabilities={closeAgentCapabilities}
        showTodos={!dockViewsEnabled && showTodos}
        onShowTodosChange={handleSetShowTodos}
        todos={todos}
        plan={plan}
        onClearPlan={handleClearPlan}
        onOpenPlan={workspace ? handleOpenPlan : undefined}
        schedulerOpen={schedulerOpen}
        onCloseScheduler={closeScheduler}
        showPalette={paletteOpen}
        palettePage={palettePage}
        paletteKey={paletteKey}
        paletteCommands={paletteCommands}
        quickOpenOpen={quickOpenOpen}
        quickOpenQuery={quickOpenQuery}
        quickOpenWorkspaceFiles={quickOpenWorkspaceFiles}
        quickOpenFilesTruncated={quickOpenFilesTruncated}
        onQuickOpenFileOpen={handleQuickOpenFileOpen}
        onClosePalette={closePalette}
        onCloseQuickOpen={closeQuickOpen}
      />    </div>
  )
}
