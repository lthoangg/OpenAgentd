/**
 * TeamChatView — top-level layout for the team chat route.
 *
 * Owns:
 *   - View-mode state (``agent`` / ``split``).
 *   - Side panels (``Sidebar``, ``WorkspaceFilesPanel``, ``SessionSettingsPanel``,
 *     todos popover, command palette).
 *   - The header (token totals, view toggle, panel toggles, agent tabs).
 *   - Mount-time SSE connect + session restore (carefully sequenced so
 *     ``loadSession`` runs *before* ``connectStream`` to avoid wiping
 *     replayed mid-turn state — see comment inside the init effect).
 *   - Keyboard shortcuts and the Command Palette assembly.
 *
 * Delegates:
 *   - ``SplitGrid``       — fixed n-pane grid layout (split mode).
 *   - ``useTeamCommands`` — Command Palette command list.
 *
 * Stream subscriptions are split into the smallest selectors that work
 * (one primitive per ``useTeamStore`` call) to avoid the infinite loop
 * that returning a freshly-built object on every render would trigger.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentView } from '../AgentView'
import { WorkspaceInfoCard } from '../WorkspaceInfoCard'
import { CodingSidebar } from '../CodingSidebar'
import { CodingWorkspacePanel } from '../CodingWorkspacePanel'
import { CodingFileViewerPanel } from '../CodingFileViewerPanel'
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel'
import { Sidebar } from '../Sidebar'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useProvidersQuery } from '@/queries'
import { queryKeys } from '@/queries/keys'
import { useCommandsQuery } from '@/queries/useCommandsQuery'
import { useSnippetsQuery } from '@/queries/useSnippetsQuery'
import { listCodingWorkspaceFiles, renderCommand, renderSnippet, resolveApiUrl, resolveTeamSession } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { useShallow } from 'zustand/react/shallow'
import { useToastStore } from '@/stores/useToastStore'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useTeamAgentsQuery } from '@/queries/useAgentsQuery'
import { useRegistryQuery } from '@/queries/useAgentFilesQuery'
import { useFileRefsQuery } from '@/queries/useFileRefsQuery'
import { AlertCircle, FolderCode, X, FileUp } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { useEdgeSwipe } from '@/hooks/use-edge-swipe'
import { useTauriDrag } from '@/hooks/use-tauri-drag'
import { Button } from '@/components/ui/button'
import { type InputBarHandle, type SlashCommand, type SnippetCommand } from '../InputBar'
import { FloatingInputBar } from '../FloatingInputBar'
import type { AgentCapabilities as AgentCapabilitiesType, MessageAttachment, WorkspaceFileInfo } from '@/api/types'
import { SplitGrid } from './SplitGrid'
import { TeamChatHeader } from './TeamChatHeader'
import { TeamChatPanels } from './TeamChatPanels'
import { AgentTabs } from './AgentTabs'
import { useTeamCommands } from './useTeamCommands'
import { VIEW_MODES, type ViewMode } from './types'
import { overlaysToClose, type MobileOverlay } from './mobileOverlays'
import { saveLastCodingWorkspace, workspaceLabel } from '@/utils/workspace'
import { setTraySession } from '@/lib/tray'
import { isEditableTarget } from '@/lib/is-editable-target'

interface TeamChatViewProps {
  sessionId?: string
  mode?: 'normal' | 'coding'
  workspace?: string | null
  codingSessionLoading?: boolean
}

interface SessionDraft {
  value: string
}

const BASE_SLASH_COMMANDS: SlashCommand[] = [
  { id: 'stop', label: 'Stop', description: 'Stop all working agents' },
  { id: 'continue', label: 'Continue', description: 'Continue the last assistant response' },
  { id: 'compact', label: 'Compact', description: 'Summarize and compact this session' },
  { id: 'undo', label: 'Undo', description: 'Undo the previous message' },
  { id: 'redo', label: 'Redo', description: 'Restore all undone messages back to the live tip' },
  { id: 'new', label: 'New Chat', description: 'Start a fresh team conversation' },
  { id: 'init', label: 'Init', description: 'Create or update AGENTS.md for this project' },
]

async function attachmentToFile(att: MessageAttachment): Promise<File | null> {
  const url = resolveApiUrl(att.url)
  if (!url) return null
  const res = await fetch(url)
  if (!res.ok) return null
  const blob = await res.blob()
  return new File(
    [blob],
    att.original_name ?? att.filename ?? 'attachment',
    { type: att.media_type ?? blob.type },
  )
}

function isDraggingFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if (!dt.types) return false
  return Array.from(dt.types).some(
    (type) =>
      type === 'Files' ||
      type === 'application/x-moz-file' ||
      type.toLowerCase().includes('file') ||
      type.toLowerCase().includes('uri')
  )
}

export function TeamChatView({ sessionId, mode = 'normal', workspace = null, codingSessionLoading = false }: TeamChatViewProps) {
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const inputRef = useRef<InputBarHandle>(null)
  const mainColumnRef = useRef<HTMLDivElement>(null)
  const [showFilesPanel, setShowFilesPanel] = useState(false)
  const [codingPanel, setCodingPanel] = useState<null | 'changed' | 'files'>(null)
  const [codingFileViewer, setCodingFileViewer] = useState<WorkspaceFileInfo | null>(null)
  const [codingFileViewerDetached, setCodingFileViewerDetached] = useState(false)
  const [codingFileOpenKey, setCodingFileOpenKey] = useState(0)
  const [codingSidebarCollapsed, setCodingSidebarCollapsed] = useState(true)
  const [openWorkspaceDialogKey, setOpenWorkspaceDialogKey] = useState(0)
  const [showTodos, setShowTodos] = useState(false)
  const [showMobileActions, setShowMobileActions] = useState(false)

  const [fileRefsEnabled, setFileRefsEnabled] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('agent')
  const draftBySessionRef = useRef<Record<string, SessionDraft>>({})

  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const dragCounterRef = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      e.preventDefault()
      dragCounterRef.current++
      if (dragCounterRef.current === 1) {
        setIsDraggingFile(true)
      }
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        setIsDraggingFile(false)
      }
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      e.preventDefault()
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDraggingFile(false)

      const droppedFiles = e.dataTransfer.files
      if (droppedFiles && droppedFiles.length > 0) {
        inputRef.current.addFiles(Array.from(droppedFiles))
      }
    }
  }, [])

  // On mobile, always force agent view — split/unified require a wide screen.
  // Also close any desktop-only panels when shrinking to mobile.
  const effectiveViewMode: ViewMode = isMobile ? 'agent' : viewMode
  useEffect(() => {
    setCodingFileViewer(null)
    setCodingFileViewerDetached(false)
  }, [workspace])

  useEffect(() => {
    if (isMobile) {
      useUIStore.getState().closeAgentCapabilities()
      setShowFilesPanel(false)
    }
  }, [isMobile])

  const storeState = useTeamStore(
    useShallow((s) => {
      const activeStream = s.activeAgent ? s.agentStreams[s.activeAgent] : undefined
      const leadStream = s.leadName ? s.agentStreams[s.leadName] : undefined
      return {
        connectStream: s.connectStream,
        loadTeamStatus: s.loadTeamStatus,
        loadSession: s.loadSession,
        sendMessage: s.sendMessage,
        continueTeam: s.continueTeam,
        beginResolvedSession: s.beginResolvedSession,
        consumeResolvedSessionReady: s.consumeResolvedSessionReady,
        setActiveAgent: s.setActiveAgent,
        setSessionModelSettings: s.setSessionModelSettings,
        setupRequired: s.setupRequired,
        dismissSetupRequired: s.dismissSetupRequired,

        activeAgent: s.activeAgent,
        agentStreams: s.agentStreams,
        agentNames: s.agentNames,
        isTeamWorking: s.isTeamWorking,
        isContinuing: s.isContinuing,
        sessionId: s.sessionId,
        sessionTitle: s.sessionTitle,
        sessionModel: s.sessionModel,
        sessionThinkingLevel: s.sessionThinkingLevel,
        sessionFastMode: s.sessionFastMode,
        leadName: s.leadName,

        activeBlocks: activeStream?.blocks,
        activeCurrentBlocks: activeStream?.currentBlocks,
        activeStatus: activeStream?.status,

        leadPromptTokens: leadStream?.usage.promptTokens ?? 0,
        leadCompletionTokens: leadStream?.usage.completionTokens ?? 0,
        leadCachedTokens: leadStream?.usage.cachedTokens ?? 0,
        leadTotalTokens: leadStream?.usage.totalTokens ?? 0,
      }
    })
  )

  const {
    connectStream,
    loadTeamStatus,
    loadSession,
    sendMessage,
    continueTeam,
    beginResolvedSession,
    consumeResolvedSessionReady,
    setActiveAgent,
    setSessionModelSettings,
    setupRequired,
    dismissSetupRequired,

    activeAgent,
    agentStreams,
    agentNames,
    isTeamWorking,
    isContinuing,
    sessionId: sessionIdState,
    sessionTitle,
    sessionModel,
    sessionThinkingLevel,
    sessionFastMode,
    leadName,

    activeBlocks,
    activeCurrentBlocks,
    activeStatus,

    leadPromptTokens,
    leadCompletionTokens,
    leadCachedTokens,
    leadTotalTokens,
  } = storeState

  const pushToast = useToastStore((s) => s.push)

  // Utility modal state lives in useUIStore so only one can be open at a time.
  const schedulerOpen = useUIStore((s) => s.schedulerOpen)
  const agentCapabilitiesOpen = useUIStore((s) => s.agentCapabilitiesOpen)
  const paletteOpen = useUIStore((s) => s.paletteOpen)
  const toggleScheduler = useUIStore((s) => s.toggleScheduler)
  const toggleAgentCapabilities = useUIStore((s) => s.toggleAgentCapabilities)
  const togglePalette = useUIStore((s) => s.togglePalette)
  const closeScheduler = useUIStore((s) => s.closeScheduler)
  const closeAgentCapabilities = useUIStore((s) => s.closeAgentCapabilities)
  const closePalette = useUIStore((s) => s.closePalette)

  // Agents whose stream isn't `offline` (i.e. not dismissed from the live
  // team). Used everywhere agents are listed for switching — split grid,
  // the agent tabs bar, and the mobile agent switcher — so dismissed
  // members disappear from pickers instead of lingering as dead tabs.
  const splitAgentNames = agentNames.filter((name) => agentStreams[name]?.status !== 'offline')
  const historyPrompts = useMemo(() => {
    const blocks = leadName ? agentStreams[leadName]?.blocks : undefined
    if (!blocks) return []
    return [...blocks]
      .reverse()
      .filter((block) => block.type === 'user' && block.content.trim())
      .map((block) => block.content)
  }, [agentStreams, leadName])

  const { data: todosData } = useTodosQuery(sessionIdState)
  const todos = todosData?.todos ?? []
  const providersQ = useProvidersQuery()
  const hasConfiguredModelProvider = providersQ.data?.providers.some(
    (provider) => provider.kind !== 'local' && provider.is_configured,
  ) ?? true

  // Lead capabilities — used to drive composer affordances (slash menu).
  const agentWorkspace = mode === 'coding' ? workspace : null
  const hasCodingWorkspace = mode !== 'coding' || Boolean(workspace)
  const isCodingSessionLoading = mode === 'coding' && codingSessionLoading
  const { data: teamAgentsData, isLoading: teamAgentsLoading } = useTeamAgentsQuery(agentWorkspace, hasCodingWorkspace)
  const leadAgent = teamAgentsData?.agents?.find((a) => a.is_lead)
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
  const voiceEnabled = true
  const voiceUnavailableReason = null

  // Workspace file/folder list for the InputBar's @-mention picker. Fetched
  // lazily — the query is keyed on workspace/session so coding and normal
  // modes don't share cache entries.
  const { refs: fileRefs } = useFileRefsQuery({
    mode,
    sessionId: sessionIdState,
    workspace,
    enabled: fileRefsEnabled && (mode === 'coding' ? Boolean(workspace) : Boolean(sessionIdState)),
  })


  const headerTokens = leadTotalTokens > 0
    ? {
        input: leadPromptTokens,
        output: leadCompletionTokens,
        cached: leadCachedTokens,
        trigger: summaryTriggerTokens,
        pulsing: isTeamWorking,
      }
    : undefined

  const abortRef = useRef<AbortController | null>(null)

  // ── Init / reconnect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (hasCodingWorkspace) loadTeamStatus(agentWorkspace)
    if (isCodingSessionLoading) return
    if (!sessionId) return
    const store = useTeamStore.getState()
    if (store.sessionId === sessionId && store.isConnected) return

    useTeamStore.setState({ sessionId })

    const draft = draftBySessionRef.current[sessionId]
    inputRef.current?.setValue(draft?.value ?? '')
    inputRef.current?.setFiles([])

    // Order matters: load prior-turn history FIRST, then open the SSE.
    //
    // Before this ordering, `connectStream()` started SSE replay (which
    // writes synthetic thinking/message events into `currentBlocks`)
    // while `loadSession()` was still inflight. When `loadSession`
    // resolved it unconditionally set `currentBlocks = []`, wiping the
    // replayed state. On mid-turn refresh the UI looked blank until the
    // next live chunk arrived — often until `done`.
    //
    // Awaiting the DB read first means `loadSession` has already committed
    // `blocks` and emptied `currentBlocks` by the time any SSE event is
    // dispatched, so replay + live events accumulate cleanly.
    let cancelled = false
    ;(async () => {
      if (!consumeResolvedSessionReady(sessionId, agentWorkspace)) {
        await loadSession(sessionId, agentWorkspace)
      }
      if (cancelled) return
      const controller = connectStream()
      if (controller) abortRef.current = controller
    })()

    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentWorkspace, hasCodingWorkspace, isCodingSessionLoading])

  useEffect(() => {
    if (!sessionId) return

    const resumeStream = () => {
      const state = useTeamStore.getState()
      if (state.sessionId !== sessionId) return
      if (state._workspace !== agentWorkspace) return
      if (state.isConnected && !state._unloading) return

      useTeamStore.setState({ _unloading: false })
      if (state.isTeamWorking) {
        void loadSession(sessionId, agentWorkspace).then(() => {
          const current = useTeamStore.getState()
          if (current.sessionId !== sessionId || current._workspace !== agentWorkspace) return
          abortRef.current = connectStream()
        })
      } else {
        abortRef.current = connectStream()
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') resumeStream()
    }

    window.addEventListener('pageshow', resumeStream)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pageshow', resumeStream)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentWorkspace])

  // ── Commands / shortcuts ───────────────────────────────────────────────────

  const isEmptyIdleSession = useCallback(() => useTeamStore.getState().isEmptyIdleSession(), [])

  const handleNewSession = useCallback(() => {
    if (isEmptyIdleSession()) return
    abortRef.current?.abort()
    abortRef.current = null
    // Eagerly delete the current session's draft before beginResolvedSession
    // resets store.sessionId to null. The InputBar's onValueChange('') effect
    // fires asynchronously after setValue(''), so by the time it calls
    // handleDraftValueChange the session id is already gone and the delete
    // never happens — leaving the old '/new' text to reappear on switch-back.
    const departingSessionId = useTeamStore.getState().sessionId
    if (departingSessionId) delete draftBySessionRef.current[departingSessionId]
    inputRef.current?.setValue('')
    inputRef.current?.setFiles([])
    ;(async () => {
      try {
        const sessionOptions = {
          mode,
          workspace: mode === 'coding' ? workspace : null,
          model: sessionIdState ? sessionModel : null,
          thinkingLevel: sessionIdState ? sessionThinkingLevel : null,
        }
        beginResolvedSession(null, sessionOptions)
        const session = await resolveTeamSession({
          ...sessionOptions,
          create: true,
        })
        beginResolvedSession(session.id, {
          mode,
          workspace: session.workspace ?? workspace,
          model: session.model ?? sessionModel,
          thinkingLevel: session.thinking_level ?? sessionThinkingLevel,
          skipInitialRestore: session.created,
        })
        if (session.created) {
          prependSession(queryClient, session)
        }
        if (mode === 'coding' && workspace) {
          if (session.created) prependWorkspaceSession(queryClient, workspace, session)
          saveLastCodingWorkspace(workspace)
          navigate({ to: '/coding/$sessionId', params: { sessionId: session.id } })
        } else {
          navigate({ to: '/cockpit/$sessionId', params: { sessionId: session.id } })
        }
      } catch (err) {
        useTeamStore.setState((state) => {
          state.error = err instanceof Error ? err.message : 'Failed to create session'
        })
      }
    })()
  }, [beginResolvedSession, isEmptyIdleSession, mode, navigate, queryClient, sessionIdState, sessionModel, sessionThinkingLevel, workspace])

  // ── Mobile single-overlay rule ─────────────────────────────────────────────
  //
  // On mobile every large surface — the session sidebar, chat-actions menu,
  // coding workspace panel, session settings (agent capabilities), the
  // scheduler, todos, the (normal-mode) files panel and the command palette
  // — is a full-screen or near-full-screen overlay. Having two open at once
  // is always a layering bug, so opening any one closes all the others.
  //
  // ``useUIStore`` already enforces this *among* scheduler / capabilities /
  // palette, and ``useEdgeSwipe`` enforces it among the drawers — but the
  // two islands plus todos / files panel never coordinated across each
  // other. This single coordinator bridges them.
  //
  // Mobile-only: sidebar / chat-actions / coding-panel are full-screen
  // overlays that shouldn't stack — guard those behind ``isMobile``.
  // Todos / files / capabilities / scheduler / palette are shared surfaces
  // that must not stack on *either* platform, so those run unconditionally.
  const closeOtherMobileOverlays = useCallback((keep: MobileOverlay) => {
    const toClose = new Set(overlaysToClose(keep))
    if (isMobile && (toClose.has('sidebar') || toClose.has('actions') || toClose.has('coding-panel'))) {
      setMobileSidebarOpen(false)
      setShowMobileActions(false)
      setCodingPanel(null)
      setCodingFileViewer(null)
      setCodingFileViewerDetached(false)
    }
    if (toClose.has('todos')) setShowTodos(false)
    if (toClose.has('files')) setShowFilesPanel(false)
    const ui = useUIStore.getState()
    if (toClose.has('scheduler')) ui.closeScheduler()
    if (toClose.has('capabilities')) ui.closeAgentCapabilities()
    if (toClose.has('palette')) ui.closePalette()
  }, [isMobile])

  const handleWorkspaceFiles = useCallback(() => {
    if (mode === 'coding') {
      if (workspace) {
        if (isMobile) { setMobileSidebarOpen(false); closeOtherMobileOverlays('coding-panel') }
        setCodingPanel((value) => {
          const next = value === null ? 'changed' : null
          if (next === null) setCodingFileViewerDetached(false)
          return next
        })
      } else {
        setCodingSidebarCollapsed(false)
        setOpenWorkspaceDialogKey((value) => value + 1)
      }
      return
    }
    if (sessionIdState) {
      setShowFilesPanel((value) => {
        const next = !value
        if (next) closeOtherMobileOverlays('files')
        return next
      })
    }
  }, [closeOtherMobileOverlays, isMobile, mode, workspace, sessionIdState])

  const handleCodingSidebarToggle = useCallback(() => {
    if (isMobile) {
      setCodingPanel(null)
      setCodingFileViewer(null)
      setMobileSidebarOpen((value) => {
        const next = !value
        if (next) closeOtherMobileOverlays('sidebar')
        return next
      })
      return
    }
    setCodingSidebarCollapsed((value) => !value)
  }, [closeOtherMobileOverlays, isMobile])

  const handleOpenWorkspaceDialog = useCallback(() => {
    setCodingSidebarCollapsed(false)
    setOpenWorkspaceDialogKey((value) => value + 1)
  }, [])

  // Focus the chat input. Callable directly (shortcut / Command Palette)
  // or indirectly via `window.dispatchEvent(new CustomEvent('focus-chat-input'))`
  // — the latter decouples future callers (buttons elsewhere, other views)
  // from this component's ref.
  const handleDraftValueChange = useCallback((value: string) => {
    const currentSessionId = useTeamStore.getState().sessionId
    if (!currentSessionId) return
    if (value) {
      draftBySessionRef.current[currentSessionId] = { value }
      return
    }
    delete draftBySessionRef.current[currentSessionId]
  }, [])

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = () => focusInput()
    window.addEventListener('focus-chat-input', handler)
    return () => window.removeEventListener('focus-chat-input', handler)
  }, [focusInput])

  useEffect(() => {
    if (isMobile || paletteOpen || (mode === 'coding' && (!workspace || isCodingSessionLoading))) return

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length !== 1 || e.key.trim().length === 0) return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.insertText(e.key)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isCodingSessionLoading, isMobile, mode, paletteOpen, workspace])

  const handleAddFileComment = useCallback((path: string, startLine: number, endLine: number) => {
    const ref = startLine === endLine ? `@${path}#L${startLine}` : `@${path}#L${startLine}-L${endLine}`
    inputRef.current?.appendValue(`${ref} `)
    inputRef.current?.focus()
  }, [])

  const handleCodingFileSelect = useCallback((file: WorkspaceFileInfo | null) => {
    setCodingFileViewer(file)
    setCodingFileViewerDetached(false)
  }, [])

  const handleMentionFileOpen = useCallback(async (path: string) => {
    if (mode !== 'coding' || !workspace) return
    const cleanPath = path.split('#', 1)[0]
    if (!cleanPath) return
    const current = codingFileViewer?.path === cleanPath ? codingFileViewer : null
    if (current) {
      setCodingFileViewer(current)
      setCodingFileViewerDetached(false)
      setCodingFileOpenKey((value) => value + 1)
      setCodingPanel((value) => value ?? 'files')
      return
    }
    try {
      const result = await listCodingWorkspaceFiles(workspace)
      const file = result.files.find((item) => item.path === cleanPath)
      if (file) {
        setCodingFileViewer(file)
        setCodingFileViewerDetached(false)
        setCodingFileOpenKey((value) => value + 1)
        setCodingPanel((value) => value ?? 'files')
      }
    } catch {
      // Keep the current panel state; the panel query will surface listing errors.
    }
  }, [codingFileViewer, mode, workspace])

  // Restore a queued message's text into the composer (fired by the
  // X button on PendingMessageQueue). Overwrites any current draft —
  // matches the /undo restore semantics above.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content?: string }>).detail
      const content = detail?.content ?? ''
      inputRef.current?.setValue(content)
      inputRef.current?.focus()
    }
    window.addEventListener('queue:restore-draft', handler)
    return () => window.removeEventListener('queue:restore-draft', handler)
  }, [])

  // Restore an undone message into the composer (fired by the undo button on
  // UserBubble in AgentView/AgentPane, which cannot access inputRef directly).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content?: string; attachments?: MessageAttachment[] }>).detail
      const content = detail?.content ?? ''
      const attachments = detail?.attachments ?? []
      inputRef.current?.setValue(content)
      void Promise.all(attachments.map((att) => attachmentToFile(att)))
        .then((files) => {
          inputRef.current?.setFiles(files.filter((f): f is File => f !== null))
          inputRef.current?.focus()
        })
    }
    window.addEventListener('undo:restore-draft', handler)
    return () => window.removeEventListener('undo:restore-draft', handler)
  }, [])

  // Push the active session/workspace label to the desktop tray. The
  // command is a no-op outside Tauri so this is safe to fire from the
  // web build too.
  //
  // Label priority — the tray reflects *liveness first*, then identity:
  //   - team currently responding → ``"Working: <ws-or-title>"``
  //     (falls back to ``"Working…"`` when no title yet — e.g. the
  //     team is generating the first message of a brand-new chat)
  //   - coding mode with workspace → ``"Coding: <ws>"``
  //   - chat with server-named session → ``"Chat: <title>"``
  //   - everything else → empty (tray shows ``No active session``)
  useEffect(() => {
    let label = ''
    const identity = mode === 'coding' && workspace
      ? workspaceLabel(workspace)
      : sessionTitle ?? ''
    if (isTeamWorking) {
      label = identity ? `Working: ${identity}` : 'Working…'
    } else if (mode === 'coding' && workspace) {
      label = `Coding: ${workspaceLabel(workspace)}`
    } else if (sessionTitle) {
      label = `Chat: ${sessionTitle}`
    }
    void setTraySession(label)
  }, [mode, workspace, sessionTitle, isTeamWorking])

  // Shell shortcut: start a message with `!` to run the rest as a shell command.
  // Slash commands for the input bar (type / to trigger).
  // Built-ins execute immediately on pick; user-defined commands are inserted
  // into the textarea (``keepInputOpen``) so the user can append
  // ``$ARGUMENTS`` before submitting.
  const commandsQ = useCommandsQuery(agentWorkspace)
  const snippetsQ = useSnippetsQuery(mode === 'coding' ? agentWorkspace : null)
  const userCommandNames = useMemo(
    () => new Set<string>((commandsQ.data?.commands ?? []).map((c) => c.name)),
    [commandsQ.data],
  )
  const slashCommands: SlashCommand[] = useMemo(() => [
    ...BASE_SLASH_COMMANDS,
    ...(commandsQ.data?.commands ?? []).map((c) => {
      const displayName = c.name.replace('/', ':')
      return {
        id: c.name,
        label: displayName,
        displayName,
        insertText: displayName,
        description: c.description || `Custom command (${c.source})`,
        category: 'command',
        keepInputOpen: true,
      }
    }),
  ], [commandsQ.data?.commands])

  const snippetCommands: SnippetCommand[] = (snippetsQ.data?.snippets ?? []).map((item) => ({
    id: item.name,
    label: item.name.replace('/', ':'),
    description: item.description || `Snippet (${item.source})`,
    category: 'snippet',
  }))

  const handleSnippetCommand = useCallback(async (id: string) => {
    if (!agentWorkspace) return null
    try {
      const res = await renderSnippet(id, agentWorkspace)
      return res.content
    } catch (err) {
      pushToast({
        tone: 'error',
        title: `Failed to render #${id.replace('/', ':')}`,
        description: (err as Error).message,
      })
      return null
    }
  }, [agentWorkspace, pushToast])

  const handleSlashCommand = useCallback((id: string) => {
    switch (id) {
      case 'stop':
        useTeamStore.getState().stopTeam()
        break
      case 'continue':
        useTeamStore.getState().continueTeam()
        break
      case 'compact':
        useTeamStore.getState().compactTeam()
        break
      case 'undo':
        void useTeamStore.getState().undoTeam().then(async (response) => {
          const message = response?.message
          if (!message || message.role !== 'user' || message.is_summary) return
          inputRef.current?.setValue(message.content ?? '')
          const attachments = message.attachments ?? []
          const files = (
            await Promise.all(attachments.map((att) => attachmentToFile(att)))
          ).filter((file): file is File => file !== null)
          inputRef.current?.setFiles(files)
          inputRef.current?.focus()
        })
        break
      case 'redo':
        void useTeamStore.getState().redoTeam().then(() => {
          inputRef.current?.setValue('')
          inputRef.current?.setFiles([])
        })
        break
      case 'new':
        handleNewSession()
        break
      case 'init':
        // Prompt body lives on the backend so it can be tweaked without a
        // web rebuild and stays the single source of truth.
        void renderCommand('init', '', agentWorkspace)
          .then((res) =>
            useTeamStore.getState().sendMessage(res.content, undefined, {
              mode,
              workspace: agentWorkspace,
            }),
          )
          .catch((err: Error) =>
            pushToast({
              tone: 'error',
              title: 'Failed to start /init',
              description: err.message,
            }),
          )
        break
    }
  }, [handleNewSession, mode, agentWorkspace, pushToast])

  /** If *content* starts with a known user-defined command, render server-side
   *  and return the expanded body; otherwise return *content* unchanged. */
  const expandUserCommand = useCallback(
    async (content: string): Promise<string> => {
      if (!content.startsWith('/')) return content
      // The command name may include slashes (nested folders), so we
      // greedily match the longest known prefix instead of splitting on
      // the first space. Tokens are separated by whitespace.
      const rest = content.slice(1)
      // Try progressively shorter prefixes — start with the full first
      // line, peel back to the longest known command name.
      const firstLine = rest.split('\n', 1)[0]
      const tokens = firstLine.split(' ')
      for (let n = tokens.length; n > 0; n--) {
        const candidate = tokens.slice(0, n).join(' ').trim()
        const commandName = candidate.replace(':', '/')
        if (userCommandNames.has(commandName)) {
          const argsHead = tokens.slice(n).join(' ')
          const restOfMessage = rest.slice(firstLine.length)
          const args = (argsHead + restOfMessage).trim()
          try {
            const res = await renderCommand(commandName, args, agentWorkspace)
            return res.content
          } catch (err) {
            pushToast({
              tone: 'error',
              title: `Failed to render /${candidate}`,
              description: (err as Error).message,
            })
            return content
          }
        }
      }
      return content
    },
    [userCommandNames, agentWorkspace, pushToast],
  )

  const cycleViewMode = useCallback(() => {
    setViewMode((v) => {
      const idx = VIEW_MODES.indexOf(v)
      return VIEW_MODES[(idx + 1) % VIEW_MODES.length]
    })
  }, [])

  const closeMobileActionsMenu = useCallback(() => setShowMobileActions(false), [])

  const handleSetShowMobileActions = useCallback<typeof setShowMobileActions>((value) => {
    setShowMobileActions((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (next && !prev) {
        closeOtherMobileOverlays('actions')
        setMobileSidebarOpen(false)
      }
      return next
    })
  }, [closeOtherMobileOverlays])

  // Cross-platform overlay toggles: when opening one overlay, close the rest.
  // closeOtherMobileOverlays now coordinates todos/files/capabilities on both
  // desktop and mobile; sidebar/actions guards stay mobile-only.
  const handleToggleAgentCapabilities = useCallback(() => {
    if (!useUIStore.getState().agentCapabilitiesOpen) closeOtherMobileOverlays('capabilities')
    toggleAgentCapabilities()
  }, [closeOtherMobileOverlays, toggleAgentCapabilities])

  const handleToggleScheduler = useCallback(() => {
    if (!useUIStore.getState().schedulerOpen) closeOtherMobileOverlays('scheduler')
    toggleScheduler()
  }, [closeOtherMobileOverlays, toggleScheduler])

  const handleTogglePalette = useCallback(() => {
    if (!useUIStore.getState().paletteOpen) closeOtherMobileOverlays('palette')
    togglePalette()
  }, [closeOtherMobileOverlays, togglePalette])

  const handleSetShowTodos = useCallback<typeof setShowTodos>((value) => {
    setShowTodos((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (next && !prev) closeOtherMobileOverlays('todos')
      return next
    })
  }, [closeOtherMobileOverlays])

  const handleToggleFilesPanel = useCallback(() => {
    if (!sessionIdState) return
    setShowFilesPanel((prev) => {
      const next = !prev
      if (next) closeOtherMobileOverlays('files')
      return next
    })
  }, [closeOtherMobileOverlays, sessionIdState])

  const commands = useTeamCommands({
    viewMode,
    cycleViewMode,
    toggleAgentCapabilities: handleToggleAgentCapabilities,
    setShowTodos: handleSetShowTodos,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    mode,
    handleNewSession,
    navigate,
  })
  const paletteCommands = commands

  // ── Coding-mode file search in the palette ─────────────────────────────────
  //
  // Fetch the workspace file listing when the palette is open (coding mode
  // only). We reuse the same query key as the @-mention picker so the two
  // share a cache entry — no extra network request when both are warm.
  const isCodingPaletteOpen = mode === 'coding' && Boolean(workspace) && paletteOpen
  const { data: paletteFilesData } = useQuery<{ files: WorkspaceFileInfo[] }>({
    queryKey: queryKeys.fileRefs.coding(workspace ?? ''),
    queryFn: async () => {
      const res = await listCodingWorkspaceFiles(workspace as string)
      return { files: res.files }
    },
    enabled: isCodingPaletteOpen,
    staleTime: 30_000,
  })

  const paletteWorkspaceFiles = isCodingPaletteOpen ? (paletteFilesData?.files ?? []) : []

  const handlePaletteFileOpen = useCallback((file: WorkspaceFileInfo) => {
    setCodingFileViewer(file)
    setCodingFileViewerDetached(false)
    setCodingFileOpenKey((k) => k + 1)
    setCodingPanel((prev) => prev ?? 'files')
  }, [])

  useKeyboardShortcuts({
    n: handleNewSession,
    // ⌘⇧A / Ctrl+Shift+A — bare ⌘A is "Select All" on macOS, so Session
    // Settings requires Shift to avoid clobbering it.
    a: { handler: handleToggleAgentCapabilities, shift: true },
    f: handleWorkspaceFiles,
    t: () => { if (sessionIdState) handleSetShowTodos((v) => !v) },
    p: isMobile ? undefined : handleTogglePalette,
    b: mode === 'coding' ? handleCodingSidebarToggle : undefined,
    // ⌘S / Ctrl+S — open the scheduler drawer (state in useUIStore).
    s: handleToggleScheduler,
    // ⌘I / Ctrl+I — focus the chat input (dispatched via CustomEvent so
    // future callers don't need a ref to the input).
    'i': () => window.dispatchEvent(new CustomEvent('focus-chat-input')),
  })



  // ── Mobile edge-swipe drawers ──────────────────────────────────────────────
  //
  // One controller owns every mobile drawer so only ONE can be open at a
  // time. The previous implementation tracked each drawer's open state in
  // isolation, which let a left-edge swipe open the sidebar while the
  // right-side actions/coding panel was already open (and vice-versa).
  //
  // Right-edge target depends on context: in a coding workspace it opens
  // the workspace panel (changed files / tree); otherwise the chat-actions
  // menu. Left-edge always opens the session sidebar.
  const codingPanelOpenForSwipe = mode === 'coding' && Boolean(workspace)

  // Single source of truth for "what is open right now". Closing routes to
  // whichever drawer the id names, so swipe-to-close hits the right one.
  const activeDrawer: string | null = mobileSidebarOpen
    ? 'sidebar'
    : showMobileActions
      ? 'actions'
      : codingPanel !== null
        ? 'coding-panel'
        : null

  const closeAllDrawers = useCallback(() => {
    setMobileSidebarOpen(false)
    setShowMobileActions(false)
    setCodingPanel(null)
    setCodingFileViewer(null)
    setCodingFileViewerDetached(false)
  }, [])

  const openLeftDrawer = useCallback(() => {
    // Opening the sidebar must vacate every other overlay first.
    closeOtherMobileOverlays('sidebar')
    setShowMobileActions(false)
    if (mode === 'coding') {
      setCodingPanel(null)
      setCodingFileViewer(null)
    }
    setMobileSidebarOpen(true)
  }, [closeOtherMobileOverlays, mode])

  const openRightDrawer = useCallback(() => {
    // Opening a right drawer must vacate the sidebar + other overlays first.
    setMobileSidebarOpen(false)
    if (codingPanelOpenForSwipe) {
      closeOtherMobileOverlays('coding-panel')
      setShowMobileActions(false)
      setCodingPanel((value) => value ?? 'changed')
    } else {
      closeOtherMobileOverlays('actions')
      setShowMobileActions(true)
    }
  }, [closeOtherMobileOverlays, codingPanelOpenForSwipe])

  const { handlers: edgeSwipeHandlers, drag: edgeSwipeDrag } = useEdgeSwipe({
    activeDrawer,
    left: { id: 'sidebar', open: openLeftDrawer },
    right: { id: codingPanelOpenForSwipe ? 'coding-panel' : 'actions', open: openRightDrawer },
    close: closeAllDrawers,
  })

  // Live drag offset (px) per drawer, fed to each drawer so it tracks the
  // finger. Each drawer reads only its own id; null when not being dragged.
  const sidebarDragOffset = edgeSwipeDrag?.drawerId === 'sidebar' ? edgeSwipeDrag.offset : null
  const actionsDragOffset = edgeSwipeDrag?.drawerId === 'actions' ? edgeSwipeDrag.offset : null
  const codingPanelDragOffset = edgeSwipeDrag?.drawerId === 'coding-panel' ? edgeSwipeDrag.offset : null

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
        <TeamChatHeader
          dragHandlers={dragHandlers}
          isMacOverlay={isMacOverlay}
          isMobile={isMobile}
          mode={mode}
          workspace={workspace}
          sessionTitle={sessionTitle}
          activeAgent={activeAgent}
          effectiveViewMode={effectiveViewMode}
          splitAgentCount={splitAgentNames.length}
          navigate={navigate}
          onCodingSidebarToggle={handleCodingSidebarToggle}
          onMobileSidebarOpen={openLeftDrawer}
          headerTokens={headerTokens}
          sessionId={sessionIdState}
          todos={todos}
          showTodos={showTodos}
          setShowTodos={handleSetShowTodos}
          showFilesPanel={showFilesPanel}
          setShowFilesPanel={setShowFilesPanel}
          onToggleFilesPanel={handleToggleFilesPanel}
          codingPanel={codingPanel}

        onWorkspaceFiles={handleWorkspaceFiles}
        agentCapabilitiesOpen={agentCapabilitiesOpen}
        onToggleAgentCapabilities={handleToggleAgentCapabilities}
        showMobileActions={showMobileActions}
        setShowMobileActions={handleSetShowMobileActions}
        mobileActionsDragOffset={actionsDragOffset}
        agentNames={splitAgentNames}
        agentStreams={agentStreams}
        onSelectAgent={setActiveAgent}
        onToggleScheduler={handleToggleScheduler}
        onCloseMobileActionsMenu={closeMobileActionsMenu}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      {/* Body row — sidebar (or coding rail) + main content column. On
          mobile the Sidebar is position:fixed (overlay drawer), so it
          takes no space here and the main column is always full-width. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {mode === 'coding' ? (
          <CodingSidebar
            currentSessionId={sessionIdState || undefined}
            workspace={workspace}
            onCollapse={() => setCodingSidebarCollapsed(true)}
            openWorkspaceDialogKey={openWorkspaceDialogKey}
            onCommandPalette={handleTogglePalette}
            desktopCollapsed={codingSidebarCollapsed}
            mobileOpen={mobileSidebarOpen}
            mobileDragOffset={sidebarDragOffset}
            onMobileClose={() => setMobileSidebarOpen(false)}
          />
        ) : (
          <Sidebar
            currentSessionId={sessionIdState || undefined}
            onCommandPalette={handleTogglePalette}
            onNewChat={handleNewSession}
            mobileOpen={mobileSidebarOpen}
            mobileDragOffset={sidebarDragOffset}
            onMobileClose={() => setMobileSidebarOpen(false)}
          />
        )}

        <main
          id="main"
          ref={mainColumnRef}
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingFile && (
            <div className="absolute inset-0 z-50 p-4 pointer-events-none drag-overlay-enter">
              <div className="w-full h-full rounded-xl border-2 border-dashed border-(--color-accent)/30 bg-(--bg-card)/80 backdrop-blur-xs flex flex-col items-center justify-center gap-2 drag-card-enter">
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
                <p className="mt-0.5 text-xs text-(--color-text-muted)">Connect a provider once, then OpenAgentd can seed and run the default team.</p>
              </div>
            </div>
            <Button size="sm" onClick={() => openSettings('providers')}>
              Open Providers
            </Button>
          </div>
        )}
        {/* Content area */}
        {effectiveViewMode === 'split' && splitAgentNames.length > 0 ? (
          <div className="min-h-0 flex-1 p-2 sm:p-3">
            <SplitGrid
              agentNames={splitAgentNames}
              leadName={leadName}
              agentStreams={agentStreams}
              isContinuing={isContinuing}
              onContinue={continueTeam}
            />
          </div>
        ) : isCodingSessionLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
            <div>
              <h2 className="text-sm font-medium text-(--color-text)">Opening coding session…</h2>
              <p className="mt-1 text-xs text-(--color-text-muted)">Loading the saved workspace for this session.</p>
            </div>
          </div>
        ) : mode === 'coding' && workspace && teamAgentsLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
            <div>
              <h2 className="text-sm font-medium text-(--color-text)">Opening coding workspace…</h2>
              <p className="mt-1 text-xs text-(--color-text-muted)">Preparing agents for {workspace}</p>
            </div>
          </div>
        ) : mode === 'coding' && !workspace ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--bg-key) text-(--color-accent)">
              <FolderCode size={24} />
            </div>
            <div>
              <h2 className="text-base font-medium text-(--color-text)">No workspace attached</h2>
              <p className="mt-1 max-w-sm text-sm text-(--color-text-muted)">
                Choose a local project folder from the sidebar to start a coding session.
              </p>
            </div>
            <Button type="button" onClick={handleOpenWorkspaceDialog}>
              Open workspace
            </Button>
          </div>
        ) : activeAgent && agentStreams[activeAgent] ? (
          <div className="flex flex-1 flex-col min-h-0">
            {effectiveViewMode === 'agent' && splitAgentNames.length > 1 && (
              <AgentTabs
                activeAgent={activeAgent}
                agents={splitAgentNames}
                streams={agentStreams}
                onSelect={setActiveAgent}
              />
            )}
            <AgentView
              blocks={activeBlocks ?? agentStreams[activeAgent].blocks}
              currentBlocks={activeCurrentBlocks ?? agentStreams[activeAgent].currentBlocks}
              isWorking={(activeStatus ?? agentStreams[activeAgent].status) === 'working'}
              isError={(activeStatus ?? agentStreams[activeAgent].status) === 'error'}
              lastError={agentStreams[activeAgent].lastError}
              isContinuing={isContinuing && activeAgent === leadName}
              onContinue={activeAgent === leadName ? continueTeam : undefined}
              onMentionFileOpen={mode === 'coding' ? handleMentionFileOpen : undefined}
              emptyState={
                mode === 'coding' && workspace ? (
                  <div className="flex flex-col items-center justify-center py-16">
                    <WorkspaceInfoCard workspace={workspace} />
                  </div>
                ) : undefined
              }
            />
          </div>
        ) : mode === 'coding' && workspace ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16">
            <WorkspaceInfoCard workspace={workspace} />
          </div>
        ) : null}

        {(mode !== 'coding' || workspace) && (
          <FloatingInputBar
            ref={inputRef}
            boundsRef={mainColumnRef}
            onSubmit={async (content: string, files?: File[], mentions?: string[]) => {
              const shell = content.startsWith('!')
              const command = shell ? content.slice(1).trim() : content
              const expanded = shell ? `!${command}` : await expandUserCommand(content)
              const current = useTeamStore.getState()
              sendMessage(expanded, files, {
                mode,
                workspace,
                model: current.sessionId ? current.sessionModel || null : null,
                thinkingLevel: current.sessionId ? current.sessionThinkingLevel || null : null,
                fastMode: current.sessionFastMode,
                shell,
                mentions,
              })
            }}
            onStop={() => useTeamStore.getState().stopTeam()}
            onSlashCommand={handleSlashCommand}
            onSnippetCommand={handleSnippetCommand}
            slashCommands={slashCommands}
            snippetCommands={snippetCommands}
            historyPrompts={historyPrompts}
            onValueChange={handleDraftValueChange}
            fileRefs={fileRefs}
            onFileRefsNeeded={() => setFileRefsEnabled(true)}
            isStreaming={isTeamWorking}
            disabled={mode === 'coding' && isCodingSessionLoading}
            placeholder={
              isTeamWorking
                ? 'Team working… type to interrupt'
                : mode === 'coding' && workspace
                  ? `Coding in ${workspaceLabel(workspace)}`
                  : 'Message the team…'
            }
            capabilities={leadCapabilities}
            voiceEnabled={voiceEnabled}
            voiceUnavailableReason={voiceUnavailableReason}
            revertedCount={leadName ? agentStreams[leadName]?.revertedCount ?? 0 : 0}
            revertedMessages={leadName ? agentStreams[leadName]?.revertedMessages ?? [] : []}
            onRedo={() => { void handleSlashCommand('redo') }}
          />
        )}
        </main>
        {/* Workspace files panel — normal (cockpit) mode only.
            Desktop: in-flow flex sibling — pushes <main> left (no overlay).
            Mobile: fixed overlay from the right. */}
        {mode !== 'coding' && (
          <WorkspaceFilesPanel
            open={showFilesPanel}
            sessionId={sessionIdState}
            onClose={() => setShowFilesPanel(false)}
          />
        )}
        {mode === 'coding' && workspace && codingFileViewer !== null && codingFileViewerDetached && codingPanel === null && (
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
        {mode === 'coding' && workspace && codingPanel !== null && (
          <CodingWorkspacePanel
            workspace={workspace}
            open
            initialTab={codingPanel}
            mobile={isMobile}
            mobileDragOffset={codingPanelDragOffset}
            selectedFilePath={codingFileViewer?.path ?? null}
            selectedFileOpenKey={codingFileOpenKey}
            onFileSelect={handleCodingFileSelect}
            onAddComment={handleAddFileComment}
            onOpenPalette={handleTogglePalette}
            onClose={() => {
              setCodingPanel(null)
              setCodingFileViewerDetached(false)
            }}
          />
        )}
      </div>

      <TeamChatPanels
        agentCapabilitiesOpen={agentCapabilitiesOpen}
        agentWorkspace={agentWorkspace}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        sessionFastMode={sessionFastMode}
        onSessionModelSettingsChange={setSessionModelSettings}
        onCloseAgentCapabilities={closeAgentCapabilities}
        mode={mode}
        sessionId={sessionIdState}
        isMobile={isMobile}
        showTodos={showTodos}
        onShowTodosChange={handleSetShowTodos}
        todos={todos}
        schedulerOpen={schedulerOpen}
        onCloseScheduler={closeScheduler}
        workspace={workspace}
        showPalette={paletteOpen}
        paletteCommands={paletteCommands}
        paletteWorkspaceFiles={paletteWorkspaceFiles}
        onPaletteFileOpen={handlePaletteFileOpen}
        onClosePalette={closePalette}
      />    </div>
  )
}
