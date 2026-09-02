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
import { memo, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AgentView } from '../AgentView'
import { WorkspaceInfoCard } from '../WorkspaceInfoCard'
import { CodingSidebar } from '../CodingSidebar'
import { CodingWorkspacePanel } from '../CodingWorkspacePanel'
import { CodingFileViewerPanel } from '../CodingFileViewerPanel'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useProvidersQuery } from '@/queries'
import { useAgentStore, isAwaitingRestartOutput } from '@/stores/useAgentStore'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useAgentsQuery } from '@/queries/useAgentsQuery'
import { useRegistryQuery } from '@/queries/useAgentSettingsQueries'
import type { ContentBlock, MessageAttachment } from '@/api/types'

type RevertedMessage = { role: string; content: string; attachments?: MessageAttachment[] }
const EMPTY_BLOCKS: ContentBlock[] = []
const EMPTY_REVERTED_MESSAGES: RevertedMessage[] = []

interface ActiveAgentViewProps {
  emptyState?: React.ReactNode
  onMentionFileOpen?: (path: string) => void
}

const ActiveAgentView = memo(function ActiveAgentView({
  emptyState,
  onMentionFileOpen,
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
      emptyState={emptyState}
    />
  )
})
import { useFileRefsQuery } from '@/queries/useFileRefsQuery'
import { AlertCircle, FolderCode, X, FileUp } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { useTauriDrag } from '@/hooks/use-tauri-drag'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { type InputComposerHandle } from '../InputComposer'
import { FloatingInputComposer } from '../FloatingInputComposer'
import type { AgentCapabilities as AgentCapabilitiesType } from '@/api/types'
import { AgentChatHeader } from './AgentChatHeader'
import { AgentChatPanels } from './AgentChatPanels'
import { AppFooter } from '../AppFooter'
import { workspaceLabel } from '@/utils/workspace'
import { useDragDrop } from './useDragDrop'
import { useOverlayState } from './useOverlayState'
import { useSessionBootstrap } from './useSessionBootstrap'
import { useSlashCommands } from './useSlashCommands'
import { useCommandPalette } from './useCommandPalette'
import { parseBuiltInSlashCommand } from './helpers'

interface AgentChatViewProps {
  sessionId?: string
  workspace?: string | null
  codingSessionLoading?: boolean
}

export function AgentChatView({ sessionId, workspace = null, codingSessionLoading = false }: AgentChatViewProps) {
  const navigate = useNavigate()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const { isMacOverlay } = usePlatform()
  // Manual drag pattern: a mousedown handler that only starts a drag
  // when the user pressed on the bare header, not on a child button.
  // The hook returns `{}` outside Tauri so the spread is a no-op in
  // browsers. See ``useTauriDrag`` for details.
  const dragHandlers = useTauriDrag()
  const inputRef = useRef<InputComposerHandle>(null)
  const mainColumnRef = useRef<HTMLDivElement>(null)

  const [fileRefsEnabled, setFileRefsEnabled] = useState(false)

  const { isDraggingFile, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } = useDragDrop(inputRef)

  const storeState = useAgentStore(
    useShallow((s) => {
      const leadStream = s.leadName ? s.agentStreams[s.leadName] : undefined
      return {
        connectStream: s.connectStream,
        loadAgentStatus: s.loadAgentStatus,
        loadSession: s.loadSession,
        sendMessage: s.sendMessage,
        beginResolvedSession: s.beginResolvedSession,
        consumeResolvedSessionReady: s.consumeResolvedSessionReady,
        setSessionModelSettings: s.setSessionModelSettings,
        setupRequired: s.setupRequired,
        dismissSetupRequired: s.dismissSetupRequired,

        isAgentWorking: s.isAgentWorking,
        sessionId: s.sessionId,
        sessionTitle: s.sessionTitle,
        sessionModel: s.sessionModel,
        sessionThinkingLevel: s.sessionThinkingLevel,
        sessionFastMode: s.sessionFastMode,

        leadRevertedCount: leadStream?.revertedCount ?? 0,
        leadRevertedMessages: leadStream?.revertedMessages ?? EMPTY_REVERTED_MESSAGES,
        leadHasVisibleBlocks: (leadStream?.blocks.length ?? 0) > 0,

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
    sendMessage,
    beginResolvedSession,
    consumeResolvedSessionReady,
    setSessionModelSettings,
    setupRequired,
    dismissSetupRequired,

    isAgentWorking,
    sessionId: sessionIdState,
    sessionTitle,
    sessionModel,
    sessionThinkingLevel,

    leadRevertedCount,
    leadRevertedMessages,
    leadHasVisibleBlocks,
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
  const quickOpenOpen = useUIStore((s) => s.quickOpenOpen)
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
    codingPanel,
    setCodingPanel,
    codingFileViewer,
    setCodingFileViewer,
    codingFileViewerDetached,
    setCodingFileViewerDetached,
    codingFileOpenKey,
    setCodingFileOpenKey,
    terminalOpenKey,
    handledTerminalOpenKeyRef,
    codingSidebarCollapsed,
    setCodingSidebarCollapsed,
    openWorkspaceDialogKey,
    showTodos,
    showMobileActions,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    handleOpenWorkspaceDialog,
    handleCodingFileSelect,
    handleMentionFileOpen,
    closeMobileActionsMenu,
    handleSetShowMobileActions,
    handleToggleAgentCapabilities,
    handleToggleScheduler,
    handleTogglePalette,
    handleToggleQuickOpen,
    handleSetShowTodos,
    handleOpenTerminal,
    edgeSwipeHandlers,
    sidebarDragOffset,
    actionsDragOffset,
    codingPanelDragOffset,
  } = useOverlayState({
    isMobile,
    workspace,
    toggleScheduler,
    toggleAgentCapabilities,
    togglePalette,
    toggleQuickOpen,
  })

  const leadBlocks = useAgentStore((s) => (
    s.leadName ? s.agentStreams[s.leadName]?.blocks ?? EMPTY_BLOCKS : EMPTY_BLOCKS
  ))
  const historyPrompts = useMemo(() => (
    [...leadBlocks]
      .reverse()
      .filter((block) => block.type === 'user' && block.content.trim())
      .map((block) => block.content)
  ), [leadBlocks])

  const { data: todosData } = useTodosQuery(sessionIdState)
  const todos = todosData?.todos ?? []
  const providersQ = useProvidersQuery()
  const hasConfiguredModelProvider = providersQ.data?.providers.some(
    (provider) => provider.kind !== 'local' && provider.is_configured,
  ) ?? true

  // Lead capabilities — used to drive composer affordances (slash menu).
  const agentWorkspace = workspace
  const hasCodingWorkspace = Boolean(workspace)
  const isCodingSessionLoading = codingSessionLoading
  const { data: agentRegistryData, isLoading: agentRegistryLoading } = useAgentsQuery(agentWorkspace, hasCodingWorkspace)
  const leadAgent = agentRegistryData?.agents?.[0]
  const leadCapabilities: AgentCapabilitiesType | undefined = leadAgent?.capabilities

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
  // Fetched lazily when a coding workspace is available.
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
    agentWorkspace,
    hasCodingWorkspace,
    isCodingSessionLoading,
    isMobile,
    paletteOpen,
    sessionModel,
    sessionThinkingLevel,
    sessionTitle,
    isAgentWorking,
    inputRef,
    navigate,
    queryClient,
    connectStream,
    loadAgentStatus,
    loadSession,
    beginResolvedSession,
    consumeResolvedSessionReady,
  })

  // ── Commands / shortcuts ───────────────────────────────────────────────────

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
  })

  const {
    paletteCommands,
    quickOpenWorkspaceFiles,
    quickOpenFilesTruncated,
    handleQuickOpenFileOpen,
  } = useCommandPalette({
    workspace,
    quickOpenOpen,
    sessionIdState,
    navigate,
    handleNewSession,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    handleToggleAgentCapabilities,
    handleSetShowTodos,
    handleTogglePalette,
    handleToggleQuickOpen,
    handleToggleScheduler,
    handleOpenTerminal,
    setCodingFileViewer,
    setCodingFileViewerDetached,
    setCodingFileOpenKey,
    setCodingPanel,
  })

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // h-dvh handles iOS Safari's dynamic toolbar.
    <div
      className="mobile-safe-shell mobile-viewport flex h-dvh flex-col bg-(--bg-page)"
      {...edgeSwipeHandlers}
    >
      {/* 40 px header above the sidebar/content row. On macOS Tauri it
          doubles as the window drag region via useTauriDrag, with a
          70 px left inset reserved for the OS traffic-lights. */}
        <AgentChatHeader
          dragHandlers={dragHandlers}
          isMacOverlay={isMacOverlay}
          isMobile={isMobile}
          workspace={workspace}
          sessionTitle={sessionTitle}
          onCodingSidebarToggle={handleCodingSidebarToggle}
          headerTokens={headerTokens}
          sessionId={sessionIdState}
          todos={todos}
          showTodos={showTodos}
          setShowTodos={handleSetShowTodos}
          codingPanel={codingPanel}

        onWorkspaceFiles={handleWorkspaceFiles}
        agentCapabilitiesOpen={agentCapabilitiesOpen}
        onToggleAgentCapabilities={handleToggleAgentCapabilities}
        showMobileActions={showMobileActions}
        setShowMobileActions={handleSetShowMobileActions}
        mobileActionsDragOffset={actionsDragOffset}
        onToggleScheduler={handleToggleScheduler}
        onCloseMobileActionsMenu={closeMobileActionsMenu}
      />

      {/* Body row — sidebar (or coding rail) + main content column. On
          mobile the Sidebar is position:fixed (overlay drawer), so it
          takes no space here and the main column is always full-width. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <CodingSidebar
            currentSessionId={sessionIdState || undefined}
            workspace={workspace}
            onCollapse={() => setCodingSidebarCollapsed(true)}
            openWorkspaceDialogKey={openWorkspaceDialogKey}
            onQuickOpen={handleToggleQuickOpen}
            onCommandPalette={handleTogglePalette}
            desktopCollapsed={codingSidebarCollapsed}
            mobileOpen={mobileSidebarOpen}
            mobileDragOffset={sidebarDragOffset}
            onMobileClose={() => setMobileSidebarOpen(false)}
        />

        <main
          id="main"
          ref={mainColumnRef}
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
          // Opts this column out of the global stray-file-drop guard
          // (usePreventStrayFileDrop) — drops landing here are ours to handle.
          data-file-drop-zone
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingFile && (
            <div className="absolute inset-0 z-50 p-4 pointer-events-none drag-overlay-enter">
              <div className="w-full h-full rounded-lg border-2 border-dashed border-(--color-accent)/30 bg-(--bg-card)/80 backdrop-blur-xs flex flex-col items-center justify-center gap-2 drag-card-enter">
                <FileUp size={24} className="text-(--color-accent) animate-pulse" />
                <span className="text-sm font-medium text-(--color-text)">
                  Drop files to attach
                </span>
              </div>
            </div>
          )}
        {setupRequired && (
          <div className="mx-3 mt-3 flex flex-col gap-3 rounded-sm border border-(--accent-blue)/35 bg-(--accent-blue-soft) p-3 text-sm text-(--color-text) shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-(--accent-blue)" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium">Configure a provider to start chatting</p>
                <p className="mt-0.5 text-xs text-(--color-text-muted)">{setupRequired.message}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
              <Button
                size="sm"
                onClick={() => openSettings('providers')}
              >
                Open Providers
              </Button>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-8 md:w-8"
                onClick={dismissSetupRequired}
                aria-label="Dismiss provider setup notice"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {!setupRequired && !hasConfiguredModelProvider && (
          <div className="mx-3 mt-3 flex flex-col gap-3 rounded-sm border border-(--color-border) bg-(--bg-card) p-3 text-sm text-(--color-text) shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-(--color-accent)" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium">No model provider configured</p>
                <p className="mt-0.5 text-xs text-(--color-text-muted)">Connect a provider once, then OpenAgentd can seed and run your default agent.</p>
              </div>
            </div>
            <Button size="sm" onClick={() => openSettings('providers')}>
              Open Providers
            </Button>
          </div>
        )}
        {isCodingSessionLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
            <div>
              <h2 className="text-sm font-medium text-(--color-text)">Opening coding session…</h2>
              <p className="mt-1 text-xs text-(--color-text-muted)">Loading the saved workspace for this session.</p>
            </div>
          </div>
        ) : workspace && agentRegistryLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
            <div>
              <h2 className="text-sm font-medium text-(--color-text)">Opening coding workspace…</h2>
              <p className="mt-1 text-xs text-(--color-text-muted)">Preparing agents for {workspace}</p>
            </div>
          </div>
        ) : !workspace ? (
          <EmptyState
            icon={FolderCode}
            title="No workspace attached"
            body="Choose a local project folder from the sidebar to start a coding session."
            action={
              <Button type="button" onClick={handleOpenWorkspaceDialog}>
                Open workspace
              </Button>
            }
          />
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <ActiveAgentView
              onMentionFileOpen={handleMentionFileOpen}
              emptyState={
                workspace ? (
                  <div className="flex flex-col items-center justify-center py-16">
                    <WorkspaceInfoCard workspace={workspace} />
                  </div>
                ) : undefined
              }
            />
          </div>
        )}

        {workspace && (
          <FloatingInputComposer
            ref={inputRef}
            boundsRef={mainColumnRef}
            onSubmit={async (content: string, files?: File[], mentions?: string[]) => {
              if (!workspace) return
              if (!files || files.length === 0) {
                const builtInCmd = parseBuiltInSlashCommand(content)
                if (builtInCmd) {
                  handleSlashCommand(builtInCmd)
                  return
                }
              }
              const expanded = await expandUserCommand(content)
              const current = useAgentStore.getState()
              const delivered = await sendMessage(expanded, files, {
                workspace,
                model: current.sessionModel || null,
                thinkingLevel: current.sessionThinkingLevel || null,
                fastMode: current.sessionFastMode,
                mentions,
              })
              // The composer cleared itself the moment this handler was
              // called. If the send never landed, hand the draft and its
              // attachments back instead of letting them disappear with an
              // error banner as the only trace.
              if (!delivered) inputRef.current?.restoreLastSubmission()
            }}
            onStop={() => useAgentStore.getState().stopAgent()}
            onSlashCommand={handleSlashCommand}
            onSnippetCommand={handleSnippetCommand}
            slashCommands={slashCommands}
            snippetCommands={snippetCommands}
            historyPrompts={historyPrompts}
            onValueChange={handleDraftValueChange}
            fileRefs={fileRefs}
            onFileRefsNeeded={() => setFileRefsEnabled(true)}
            isStreaming={isAgentWorking}
            disabled={isCodingSessionLoading}
            placeholder={
              isAgentWorking
                ? 'Agent working… type to interrupt'
                : `Coding in ${workspaceLabel(workspace)}`
            }
            capabilities={leadCapabilities}
            revertedCount={leadRevertedCount}
            revertedMessages={leadRevertedMessages}
            onRedo={() => { void handleSlashCommand('redo') }}
            onRedoAll={() => { void handleSlashCommand('redo-all') }}
          />
        )}
        </main>
        {/* Workspace files panel — coding workspace only.
            Desktop: in-flow flex sibling — pushes <main> left (no overlay).
            Mobile: fixed overlay from the right. */}
        {workspace && codingFileViewer !== null && codingFileViewerDetached && codingPanel === null && (
          <CodingFileViewerPanel
            workspace={workspace}
            file={codingFileViewer}
            mobile={isMobile}
            onAddComment={handleAddFileComment}
            onClose={() => {
              setCodingFileViewer(null)
              setCodingFileViewerDetached(false)
            }}
          />
        )}
        <AnimatePresence initial={false}>
          {workspace && codingPanel !== null && (
            <CodingWorkspacePanel
              workspace={workspace}
              open
              initialTab={codingPanel}
              mobile={isMobile}
              mobileDragOffset={codingPanelDragOffset}
              selectedFilePath={codingFileViewer?.path ?? null}
              selectedFileOpenKey={codingFileOpenKey}
              terminalOpenKey={terminalOpenKey}
              handledTerminalOpenKeyRef={handledTerminalOpenKeyRef}
              onFileSelect={handleCodingFileSelect}
              onAddComment={handleAddFileComment}
              onOpenPalette={handleToggleQuickOpen}
              onClose={() => {
                setCodingPanel(null)
                setCodingFileViewerDetached(false)
              }}
            />
          )}
        </AnimatePresence>
      </div>

      <AppFooter
        workspace={workspace}
        sessionId={sessionIdState}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        sessionFastMode={storeState.sessionFastMode}
        onToggleScheduler={handleToggleScheduler}
        onToggleSessionSettings={handleToggleAgentCapabilities}
        onTogglePalette={handleTogglePalette}
        onOpenGitChanges={workspace ? handleWorkspaceFiles : undefined}
      />

      <AgentChatPanels
        agentCapabilitiesOpen={agentCapabilitiesOpen}
        agentWorkspace={agentWorkspace}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        onSessionModelSettingsChange={setSessionModelSettings}
        onCloseAgentCapabilities={closeAgentCapabilities}
        sessionId={sessionIdState}
        isMobile={isMobile}
        showTodos={showTodos}
        onShowTodosChange={handleSetShowTodos}
        todos={todos}
        schedulerOpen={schedulerOpen}
        onCloseScheduler={closeScheduler}
        showPalette={paletteOpen}
        paletteCommands={paletteCommands}
        quickOpenOpen={quickOpenOpen}
        quickOpenWorkspaceFiles={quickOpenWorkspaceFiles}
        quickOpenFilesTruncated={quickOpenFilesTruncated}
        onQuickOpenFileOpen={handleQuickOpenFileOpen}
        onClosePalette={closePalette}
        onCloseQuickOpen={closeQuickOpen}
      />    </div>
  )
}
