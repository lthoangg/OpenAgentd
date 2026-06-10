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
import { AnimatePresence, motion } from 'framer-motion'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { SessionSettingsPanel } from '../SessionSettingsPanel'
import { AgentView } from '../AgentView'
import { WorkspaceInfoCard } from '../WorkspaceInfoCard'
import { CodingSidebar } from '../CodingSidebar'
import { CodingWorkspacePanel } from '../CodingWorkspacePanel'
import { CodingFileViewerPanel } from '../CodingFileViewerPanel'
import { Sidebar } from '../Sidebar'
import { CommandPalette } from '../CommandPalette'
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel'
import { TodosPopover } from '../TodosPopover'
import { WikiPanel } from '../WikiPanel'
import { SchedulerPanel } from '../SchedulerPanel'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useProvidersQuery, useTriggerDreamMutation } from '@/queries'
import { useCommandsQuery } from '@/queries/useCommandsQuery'
import { useSnippetsQuery } from '@/queries/useSnippetsQuery'
import { renderCommand, renderSnippet, resolveApiUrl, resolveTeamSession } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { useToastStore } from '@/stores/useToastStore'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { useUIStore } from '@/stores/useUIStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useTeamAgentsQuery } from '@/queries/useAgentsQuery'
import { useFileRefsQuery } from '@/queries/useFileRefsQuery'
import { AlertCircle, Brain, CalendarClock, Check, ChevronDown, FolderOpen, FolderCode, Home, ListTodo, Menu, MoreHorizontal, SlidersHorizontal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { useTauriDrag } from '@/hooks/use-tauri-drag'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isAgentRole, type AgentRole } from '@/lib/agent-roles'
import type { AgentStream } from '@/stores/useTeamStore'
import { AgentTopbar } from '@/components/AgentTopbar'
import { type InputBarHandle, type SlashCommand, type SnippetCommand } from '../InputBar'
import { FloatingInputBar } from '../FloatingInputBar'
import type { AgentCapabilities as AgentCapabilitiesType, MessageAttachment, WorkspaceFileInfo } from '@/api/types'
import { SplitGrid } from './SplitGrid'
import { useTeamCommands } from './useTeamCommands'
import { VIEW_MODES, type ViewMode } from './types'
import { saveLastCodingWorkspace, workspaceLabel } from '@/utils/workspace'
import { formatTokens } from '@/utils/format'
import { setTraySession } from '@/lib/tray'
import { parseLoopCommand } from '@/lib/parseLoopCommand'

interface TeamChatViewProps {
  sessionId?: string
  mode?: 'normal' | 'coding'
  workspace?: string | null
  codingSessionLoading?: boolean
}

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

export function TeamChatView({ sessionId, mode = 'normal', workspace = null, codingSessionLoading = false }: TeamChatViewProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const { isMacOverlay, os } = usePlatform()
  // Manual drag pattern: a mousedown handler that only starts a drag
  // when the user pressed on the bare header, not on a child button.
  // The hook returns `{}` outside Tauri so the spread is a no-op in
  // browsers. See ``useTauriDrag`` for details.
  const dragHandlers = useTauriDrag()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const inputRef = useRef<InputBarHandle>(null)
  const mainColumnRef = useRef<HTMLDivElement>(null)
  const mobileSidebarSwipeStartRef = useRef<{ x: number; y: number } | null>(null)
  const mobileActionsSwipeStartRef = useRef<{ x: number; y: number } | null>(null)
  const [showFilesPanel, setShowFilesPanel] = useState(false)
  const [codingPanel, setCodingPanel] = useState<null | 'files' | 'diff'>(null)
  const [codingFileViewer, setCodingFileViewer] = useState<WorkspaceFileInfo | null>(null)
  const [codingSidebarCollapsed, setCodingSidebarCollapsed] = useState(true)
  const [openWorkspaceDialogKey, setOpenWorkspaceDialogKey] = useState(0)
  const [showTodos, setShowTodos] = useState(false)
  const [showMobileActions, setShowMobileActions] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [fileRefsEnabled, setFileRefsEnabled] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('agent')

  // On mobile, always force agent view — split/unified require a wide screen.
  // Also close any desktop-only panels when shrinking to mobile.
  const effectiveViewMode: ViewMode = isMobile ? 'agent' : viewMode
  useEffect(() => {
    setCodingFileViewer(null)
  }, [workspace])

  useEffect(() => {
    if (isMobile) {
      useUIStore.getState().closeAgentCapabilities()
      setShowFilesPanel(false)
    }
  }, [isMobile])

  const connectStream  = useTeamStore((s) => s.connectStream)
  const loadTeamStatus = useTeamStore((s) => s.loadTeamStatus)
  const loadSession    = useTeamStore((s) => s.loadSession)
  const sendMessage    = useTeamStore((s) => s.sendMessage)
  const continueTeam   = useTeamStore((s) => s.continueTeam)
  const beginResolvedSession = useTeamStore((s) => s.beginResolvedSession)
  const consumeResolvedSessionReady = useTeamStore((s) => s.consumeResolvedSessionReady)
  const cycleActiveAgent = useTeamStore((s) => s.cycleActiveAgent)
  const setActiveAgent   = useTeamStore((s) => s.setActiveAgent)
  const setSessionModelSettings = useTeamStore((s) => s.setSessionModelSettings)
  const setupRequired = useTeamStore((s) => s.setupRequired)
  const dismissSetupRequired = useTeamStore((s) => s.dismissSetupRequired)

  const dreamMutation = useTriggerDreamMutation()
  const pushToast = useToastStore((s) => s.push)

  const activeAgent    = useTeamStore((s) => s.activeAgent)
  const agentStreams   = useTeamStore((s) => s.agentStreams)
  const agentNames     = useTeamStore((s) => s.agentNames)
  const isTeamWorking  = useTeamStore((s) => s.isTeamWorking)
  const isContinuing   = useTeamStore((s) => s.isContinuing)
  const sessionIdState = useTeamStore((s) => s.sessionId)
  const sessionTitle   = useTeamStore((s) => s.sessionTitle)
  const sessionModel   = useTeamStore((s) => s.sessionModel)
  const sessionThinkingLevel = useTeamStore((s) => s.sessionThinkingLevel)
  const sessionFastMode = useTeamStore((s) => s.sessionFastMode)
  const leadName       = useTeamStore((s) => s.leadName)

  // Utility modal state lives in useUIStore so only one can be open at a time.
  const wikiOpen = useUIStore((s) => s.wikiOpen)
  const schedulerOpen = useUIStore((s) => s.schedulerOpen)
  const agentCapabilitiesOpen = useUIStore((s) => s.agentCapabilitiesOpen)
  const toggleWiki = useUIStore((s) => s.toggleWiki)
  const toggleScheduler = useUIStore((s) => s.toggleScheduler)
  const toggleAgentCapabilities = useUIStore((s) => s.toggleAgentCapabilities)
  const closeWiki = useUIStore((s) => s.closeWiki)
  const closeScheduler = useUIStore((s) => s.closeScheduler)
  const closeAgentCapabilities = useUIStore((s) => s.closeAgentCapabilities)

  // Subscribe to active-agent stream fields directly to avoid recomputing on
  // every other agent's tick.
  const activeBlocks        = useTeamStore((s) => s.activeAgent ? s.agentStreams[s.activeAgent]?.blocks : undefined)
  const activeCurrentBlocks = useTeamStore((s) => s.activeAgent ? s.agentStreams[s.activeAgent]?.currentBlocks : undefined)
  const activeStatus        = useTeamStore((s) => s.activeAgent ? s.agentStreams[s.activeAgent]?.status : undefined)

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
  const leadCapabilities: AgentCapabilitiesType | undefined = teamAgentsData?.agents
    ?.find((a) => a.is_lead)?.capabilities
  const selectedModel = sessionModel ?? ''
  const selectedThinkingLevel = sessionThinkingLevel ?? ''
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

  // Sum tokens — four primitive selectors, no new object returned (avoids infinite loop).
  const totalPrompt     = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.promptTokens, 0))
  const totalCompletion = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.completionTokens, 0))
  const totalCached     = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.cachedTokens, 0))
  const totalAll        = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.totalTokens, 0))

  const abortRef = useRef<AbortController | null>(null)

  // ── Init / reconnect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (hasCodingWorkspace) loadTeamStatus(agentWorkspace)
    if (isCodingSessionLoading) return
    if (!sessionId) return
    const store = useTeamStore.getState()
    if (store.sessionId === sessionId && store.isConnected) return

    useTeamStore.setState({ sessionId })

    // Clear the composer when switching sessions. The InputBar holds its
    // draft text and pending files in local state, so without an explicit
    // reset session A's typed-but-unsent message bleeds into session B.
    inputRef.current?.setValue('')
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

  const handleWorkspaceFiles = useCallback(() => {
    if (mode === 'coding') {
      if (workspace) {
        setCodingPanel((value) => {
          const next = value === null ? 'files' : null
          if (next === null) setCodingFileViewer(null)
          return next
        })
      } else {
        setCodingSidebarCollapsed(false)
        setOpenWorkspaceDialogKey((value) => value + 1)
      }
      return
    }
    if (sessionIdState) setShowFilesPanel((value) => !value)
  }, [mode, workspace, sessionIdState])

  const handleCodingSidebarToggle = useCallback(() => {
    setCodingSidebarCollapsed((value) => !value)
  }, [])

  const handleOpenWorkspaceDialog = useCallback(() => {
    setCodingSidebarCollapsed(false)
    setOpenWorkspaceDialogKey((value) => value + 1)
  }, [])

  const handleDreamRun = useCallback(() => {
    dreamMutation.mutate(undefined, {
      onSuccess: (result) => {
        if (result.skipped) {
          pushToast({
            tone: 'info',
            title: 'Dream skipped',
            description: `${result.skipped}. ${result.remaining} pending.`,
          })
          return
        }
        const { sessions_processed, notes_processed, remaining } = result
        const processed = sessions_processed + notes_processed
        pushToast({
          tone: 'success',
          title: 'Dream complete',
          description: processed > 0
            ? `${processed} item${processed !== 1 ? 's' : ''} processed. ${remaining} remaining.`
            : `Nothing to process.`,
        })
      },
      onError: (err) => {
        pushToast({
          tone: 'error',
          title: 'Dream failed',
          description: err instanceof Error ? err.message : String(err),
        })
      },
    })
  }, [dreamMutation, pushToast])

  // Focus the chat input. Callable directly (shortcut / Command Palette)
  // or indirectly via `window.dispatchEvent(new CustomEvent('focus-chat-input'))`
  // — the latter decouples future callers (buttons elsewhere, other views)
  // from this component's ref.
  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = () => focusInput()
    window.addEventListener('focus-chat-input', handler)
    return () => window.removeEventListener('focus-chat-input', handler)
  }, [focusInput])

  useEffect(() => {
    if (isMobile || showPalette || (mode === 'coding' && (!workspace || isCodingSessionLoading))) return

    const isEditableElement = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      return target.closest('input, textarea, select, [contenteditable="true"]') !== null
    }

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length !== 1 || e.key.trim().length === 0) return
      if (isEditableElement(e.target)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.insertText(e.key)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isCodingSessionLoading, isMobile, mode, showPalette, workspace])

  const handleAddFileComment = useCallback((path: string, startLine: number, endLine: number) => {
    const ref = startLine === endLine ? `@${path}#L${startLine}` : `@${path}#L${startLine}-L${endLine}`
    inputRef.current?.appendValue(`${ref} `)
    inputRef.current?.focus()
  }, [])

  const handleCodingFileSelect = useCallback((file: WorkspaceFileInfo | null) => {
    setCodingFileViewer(file)
    if (isMobile && file) setCodingPanel(null)
  }, [isMobile])

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
  const slashCommands: SlashCommand[] = [
    { id: 'stop', label: 'Stop', description: 'Stop all working agents' },
    { id: 'continue', label: 'Continue', description: 'Continue the last assistant response' },
    { id: 'compact', label: 'Compact', description: 'Summarize and compact this session' },
    { id: 'undo', label: 'Undo', description: 'Undo the previous message' },
    { id: 'redo', label: 'Redo', description: 'Restore all undone messages back to the live tip' },
    { id: 'new', label: 'New Chat', description: 'Start a fresh team conversation' },
    { id: 'init', label: 'Init', description: 'Create or update AGENTS.md for this project' },
    ...(mode === 'coding'
      ? [
          { id: 'loop', label: 'loop <prompt>', displayName: 'loop', insertText: 'loop', description: 'Start a coding loop', keepInputOpen: true },
          { id: 'loop:set', label: 'loop:set <limit>', displayName: 'loop:set', insertText: 'loop:set', description: 'Set coding loop budget: 5, 10, 20, or 50', keepInputOpen: true },
          { id: 'loop:pause', label: 'loop:pause', displayName: 'loop:pause', description: 'Pause the active coding loop' },
          { id: 'loop:resume', label: 'loop:resume', displayName: 'loop:resume', description: 'Resume the paused coding loop' },
          { id: 'loop:stop', label: 'loop:stop', displayName: 'loop:stop', description: 'Stop the active coding loop' },
        ]
      : []),
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
  ]

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

  const runLoopCommand = useCallback(async (command: string, prompt?: string) => {
    const current = useTeamStore.getState()
    await current.sendLoopCommand(command, prompt, {
      mode,
      workspace,
      model: current.sessionId ? selectedModel || null : null,
      thinkingLevel: current.sessionId ? selectedThinkingLevel || null : null,
      fastMode: current.sessionFastMode,
    })
  }, [mode, workspace, selectedModel, selectedThinkingLevel])

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
      case 'loop:pause':
      case 'loop:resume':
      case 'loop:stop':
        void runLoopCommand(`/${id}`)
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
  }, [handleNewSession, runLoopCommand, mode, agentWorkspace, pushToast])

  const tryHandleBuiltinLoopCommand = useCallback(async (content: string): Promise<boolean> => {
    const parsed = parseLoopCommand(content)
    switch (parsed.kind) {
      case 'none':
        return false
      case 'unknown_subcommand':
        return false
      case 'start_missing_prompt':
        pushToast({
          tone: 'error',
          title: '/loop needs a prompt',
          description: 'Type the prompt after /loop, e.g. "/loop just say hi".',
        })
        return true
      case 'set_invalid_limit':
        pushToast({
          tone: 'error',
          title: '/loop:set needs a valid limit',
          description: 'Use one of: 5, 10, 20, or 50.',
        })
        return true
      case 'start':
        await runLoopCommand(content, parsed.prompt)
        return true
      case 'set':
        await runLoopCommand(`/loop:set ${parsed.limit}`)
        return true
      case 'pause':
      case 'resume':
      case 'stop':
        await runLoopCommand(`/loop:${parsed.kind}`)
        return true
    }
  }, [pushToast, runLoopCommand])

  /** If *content* starts with a known user-defined command, render server-side
   *  and return the expanded body; otherwise return *content* unchanged. */
  const expandUserCommand = useCallback(
    async (content: string): Promise<string> => {
      if (!content.startsWith('/')) return content
      if (content.startsWith('/loop:') || content.startsWith('/loop ')) return content
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

  const commands = useTeamCommands({
    viewMode,
    cycleViewMode,
    setViewMode,
    toggleAgentCapabilities,
    setShowTodos,
    handleWorkspaceFiles,
    handleCodingSidebarToggle,
    mode,
    handleNewSession,
    handleDreamRun,
    agentNames,
    leadName,
    cycleActiveAgent,
    setActiveAgent,
    navigate,
  })
  const paletteCommands = commands

  useKeyboardShortcuts({
    n: handleNewSession,
    v: isMobile ? undefined : cycleViewMode,
    a: toggleAgentCapabilities,
    f: handleWorkspaceFiles,
    t: () => { if (sessionIdState) setShowTodos((v) => !v) },
    p: isMobile ? undefined : () => setShowPalette((v) => !v),
    b: mode === 'coding' ? handleCodingSidebarToggle : undefined,
    // Ctrl+M / Ctrl+S — open the wiki / scheduler drawers (state in useUIStore).
    m: toggleWiki,
    s: toggleScheduler,
    // Ctrl+I — focus the chat input (dispatched via CustomEvent so future
    // callers don't need a ref to the input).
    'i': () => window.dispatchEvent(new CustomEvent('focus-chat-input')),
  })

  // Tab / Shift+Tab — cycle the active agent in the store (agent view tabs
  // and split-mode pane focus both follow store activeAgent).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      cycleActiveAgent(e.shiftKey ? 'prev' : 'next')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cycleActiveAgent])

  const handleMobileSidebarSwipeStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if ((os !== 'ios' && os !== 'android') || !isMobile || mobileSidebarOpen) return
    const touch = event.touches[0]
    if (!touch || touch.clientX > 24) return
    mobileSidebarSwipeStartRef.current = { x: touch.clientX, y: touch.clientY }
  }, [isMobile, mobileSidebarOpen, os])

  const handleMobileSidebarSwipeMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const start = mobileSidebarSwipeStartRef.current
    if (!start || (os !== 'ios' && os !== 'android') || !isMobile || mobileSidebarOpen) return
    const touch = event.touches[0]
    if (!touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (deltaX > 56 && Math.abs(deltaY) < 36) {
      setMobileSidebarOpen(true)
      mobileSidebarSwipeStartRef.current = null
    }
  }, [isMobile, mobileSidebarOpen, os])

  const handleMobileSidebarSwipeEnd = useCallback(() => {
    mobileSidebarSwipeStartRef.current = null
  }, [])

  const handleMobileActionsSwipeStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if ((os !== 'ios' && os !== 'android') || !isMobile || showMobileActions) return
    const touch = event.touches[0]
    if (!touch || window.innerWidth - touch.clientX > 24) return
    mobileActionsSwipeStartRef.current = { x: touch.clientX, y: touch.clientY }
  }, [isMobile, os, showMobileActions])

  const handleMobileActionsSwipeMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const start = mobileActionsSwipeStartRef.current
    if (!start || (os !== 'ios' && os !== 'android') || !isMobile || showMobileActions) return
    const touch = event.touches[0]
    if (!touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (deltaX < -56 && Math.abs(deltaY) < 36) {
      setShowMobileActions(true)
      mobileActionsSwipeStartRef.current = null
    }
  }, [isMobile, os, showMobileActions])

  const handleMobileActionsSwipeEnd = useCallback(() => {
    mobileActionsSwipeStartRef.current = null
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // h-dvh handles iOS Safari's dynamic toolbar.
    <div
      className="mobile-safe-shell mobile-viewport flex h-dvh flex-col bg-(--bg-page)"
      onTouchStart={(event) => {
        handleMobileSidebarSwipeStart(event)
        handleMobileActionsSwipeStart(event)
      }}
      onTouchMove={(event) => {
        handleMobileSidebarSwipeMove(event)
        handleMobileActionsSwipeMove(event)
      }}
      onTouchEnd={() => {
        handleMobileSidebarSwipeEnd()
        handleMobileActionsSwipeEnd()
      }}
      onTouchCancel={() => {
        handleMobileSidebarSwipeEnd()
        handleMobileActionsSwipeEnd()
      }}
    >
      {/* 40 px header above the sidebar/content row. On macOS Tauri it
          doubles as the window drag region via useTauriDrag, with a
          70 px left inset reserved for the OS traffic-lights. */}
      <header
        {...dragHandlers}
        className={`mobile-safe-header flex h-10 items-center border-b border-(--color-border) bg-(--bg-page) ${
          isMacOverlay ? 'select-none pl-[70px]' : ''
        }`}
      >
          {/* Desktop keeps a Home affordance in the menubar. Mobile uses
              one global nav entry and places Home inside the drawer. */}
          {!isMobile && (
            <div
              className={`flex h-full shrink-0 items-center justify-center ${
                isMacOverlay ? 'pl-2' : 'md:w-14'
              }`}
            >
              <a
                href="/"
                aria-label="Home"
                title="Home"
                className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                onClick={(event) => {
                  event.preventDefault()
                  navigate({ to: '/' })
                }}
              >
                <Home size={16} aria-hidden="true" />
              </a>
            </div>
          )}

          {/* Hamburger target depends on mode: coding sidebar toggle,
              mobile drawer, or synthetic Ctrl+B for the normal sidebar
              (whose collapse state is owned by Sidebar). */}
          <div className={isMacOverlay ? 'mr-1 flex min-w-0 shrink items-center gap-1 pl-2 md:mr-2' : 'mr-1 flex min-w-0 shrink items-center gap-1 pl-2 md:mr-2 md:pl-0'}>
            <button
              type="button"
              onClick={() => {
                if (mode === 'coding') {
                  if (isMobile) {
                    setMobileSidebarOpen((v) => !v)
                  } else {
                    setCodingSidebarCollapsed((v) => !v)
                  }
                } else if (isMobile) {
                  setMobileSidebarOpen(true)
                } else {
                  // Ctrl+B is owned by Sidebar's window listener.
                  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, metaKey: false, bubbles: true }))
                }
              }}
              aria-label="Toggle sidebar"
              title="Toggle sidebar (Ctrl+B)"
              className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-8 md:w-8"
            >
              <Menu size={16} aria-hidden="true" />
            </button>
            {mode === 'coding' && workspace && !isMobile ? (
              <span
                className="ml-1 flex min-w-0 max-w-60 items-baseline gap-1 text-sm"
                title={workspace}
              >
                <span className="shrink-0 text-(--color-text-muted)">Workspace:</span>
                <span className="truncate font-semibold text-(--color-text)">{workspaceLabel(workspace)}</span>
              </span>
            ) : mode !== 'coding' && sessionTitle && !isMobile ? (
              <span
                className="ml-1 max-w-60 truncate text-sm font-semibold text-(--color-text)"
                title={sessionTitle}
              >
                {sessionTitle}
              </span>
            ) : null}
          </div>

          {/* Active-agent chip → dropdown of all members. Split view
              collapses to a count pill — each pane already shows its
              own agent. */}
          <div className="flex min-w-0 flex-1 justify-start overflow-hidden px-1">
            {isMobile && (
              <div className="min-w-0 text-sm font-semibold text-(--color-text)">
                <div className="truncate">{mode === 'coding' && workspace ? workspaceLabel(workspace) : sessionTitle || 'Cockpit'}</div>
                {activeAgent && <div className="truncate font-mono text-[10px] font-normal text-(--color-text-muted)">{activeAgent}</div>}
              </div>
            )}
            {effectiveViewMode === 'agent' && activeAgent && !isMobile && (
              <ActiveAgentSwitcher
                activeAgent={activeAgent}
                agents={agentNames}
                streams={agentStreams}
                onSelect={setActiveAgent}
              />
            )}

            {effectiveViewMode === 'split' && (
              <span className="text-xs text-(--color-text-muted)">
                Split · {splitAgentNames.length} agents
              </span>
            )}
          </div>

          {/* Right cluster — desktop gets the full action row. Mobile keeps
              frequent actions visible and leaves secondary panels in More. */}
          <div className="flex shrink-0 items-center gap-0.5">
          {isMobile ? (
            <>
              <MobileHeaderAction
                Icon={ListTodo}
                label="Tasks"
                onClick={() => setShowTodos(true)}
                disabled={!sessionIdState}
                badge={todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length}
              />
              <MobileHeaderAction
                Icon={FolderOpen}
                label={mode === 'coding' ? 'Workspace files' : 'Session files'}
                onClick={mode === 'coding'
                  ? workspace ? handleWorkspaceFiles : undefined
                  : sessionIdState ? () => setShowFilesPanel((v) => !v) : undefined}
                active={mode === 'coding' ? codingPanel !== null : showFilesPanel}
                disabled={mode === 'coding' ? !workspace : !sessionIdState}
              />
              <MobileHeaderAction
                Icon={SlidersHorizontal}
                label="Agent settings"
                onClick={toggleAgentCapabilities}
                active={agentCapabilitiesOpen}
              />
              <MobileChatActions
                open={showMobileActions}
                onOpenChange={setShowMobileActions}
                mode={mode}
                workspace={workspace}
                activeAgent={activeAgent}
                agents={agentNames}
                streams={agentStreams}
                onSelectAgent={setActiveAgent}
                onWiki={() => { toggleWiki(); closeMobileActionsMenu() }}
                onScheduler={() => { toggleScheduler(); closeMobileActionsMenu() }}
                tokens={totalAll > 0
                  ? {
                      input: totalPrompt,
                      output: totalCompletion,
                      cached: totalCached,
                      total: totalAll,
                      pulsing: isTeamWorking,
                    }
                  : undefined}
              />
            </>
          ) : (
            <AgentTopbar
              isMobile={false}
              tokens={
                totalAll > 0
                  ? {
                      input: totalPrompt,
                      output: totalCompletion,
                      cached: totalCached,
                      pulsing: isTeamWorking,
                    }
                  : undefined
              }
              dreamRunning={dreamMutation.isPending}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              todosSlot={
                <TodosPopover
                  open={showTodos}
                  onOpenChange={setShowTodos}
                  todos={todos}
                  sessionId={sessionIdState}
                />
              }
              filesAction={mode === 'coding'
                ? workspace ? {
                    Icon: FolderOpen,
                    onClick: handleWorkspaceFiles,
                    title: codingPanel === null ? 'Workspace files and git diff' : 'Close files and diff',
                    ariaLabel: 'Workspace files and git diff',
                  } : undefined
                : {
                    Icon: FolderOpen,
                    onClick: () => setShowFilesPanel((v) => !v),
                    disabled: !sessionIdState,
                    title: sessionIdState ? 'Workspace files (Ctrl+F)' : 'No active session',
                    ariaLabel: 'Workspace files',
                  }}
              agentsAction={{
                Icon: SlidersHorizontal,
                onClick: toggleAgentCapabilities,
                title: 'Session model settings (Ctrl+A)',
                ariaLabel: 'Session model settings',
                className: agentCapabilitiesOpen ? 'mr-2 bg-(--bg-key) text-(--color-text)' : 'mr-2',
              }}
            />
          )}
          </div>
      </header>

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
            onCommandPalette={() => setShowPalette(true)}
            desktopCollapsed={codingSidebarCollapsed}
            mobileOpen={mobileSidebarOpen}
            onMobileClose={() => setMobileSidebarOpen(false)}
          />
        ) : (
          <Sidebar
            currentSessionId={sessionIdState || undefined}
            onCommandPalette={() => setShowPalette(true)}
            onNewChat={handleNewSession}
            mobileOpen={mobileSidebarOpen}
            onMobileClose={() => setMobileSidebarOpen(false)}
          />
        )}

        <main id="main" ref={mainColumnRef} className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {setupRequired && (
          <div className="mx-3 mt-3 flex flex-col gap-3 rounded-xl border border-(--accent-blue)/35 bg-(--accent-blue-soft) p-3 text-sm text-(--color-text) shadow-sm sm:flex-row sm:items-center sm:justify-between">
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
                onClick={() => navigate({ to: '/settings/providers' })}
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
          <div className="mx-3 mt-3 flex flex-col gap-3 rounded-xl border border-(--color-border) bg-(--bg-card) p-3 text-sm text-(--color-text) shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-(--color-accent)" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium">No model provider configured</p>
                <p className="mt-0.5 text-xs text-(--color-text-muted)">Connect a provider once, then OpenAgentd can seed and run the default team.</p>
              </div>
            </div>
            <Button size="sm" onClick={() => navigate({ to: '/settings/providers' })}>
              Open Providers
            </Button>
          </div>
        )}
        {/* Content area */}
        {effectiveViewMode === 'split' && splitAgentNames.length > 0 ? (
          <div className="min-h-0 flex-1 p-3">
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
          <AgentView
            blocks={activeBlocks ?? agentStreams[activeAgent].blocks}
            currentBlocks={activeCurrentBlocks ?? agentStreams[activeAgent].currentBlocks}
            isWorking={(activeStatus ?? agentStreams[activeAgent].status) === 'working'}
            isError={(activeStatus ?? agentStreams[activeAgent].status) === 'error'}
            lastError={agentStreams[activeAgent].lastError}
            isContinuing={isContinuing && activeAgent === leadName}
            onContinue={activeAgent === leadName ? continueTeam : undefined}
            emptyState={
              mode === 'coding' && workspace ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <WorkspaceInfoCard workspace={workspace} />
                </div>
              ) : undefined
            }
          />
        ) : mode === 'coding' && workspace ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16">
            <WorkspaceInfoCard workspace={workspace} />
          </div>
        ) : null}

        {(mode !== 'coding' || workspace) && (
          <FloatingInputBar
            ref={inputRef}
            boundsRef={mainColumnRef}
            onSubmit={async (content, files) => {
              if (mode === 'coding' && (await tryHandleBuiltinLoopCommand(content))) return
              const shell = content.startsWith('!')
              const command = shell ? content.slice(1).trim() : content
              const expanded = shell ? `!${command}` : await expandUserCommand(content)
              const current = useTeamStore.getState()
              sendMessage(expanded, files, {
                mode,
                workspace,
                model: current.sessionId ? selectedModel || null : null,
                thinkingLevel: current.sessionId ? selectedThinkingLevel || null : null,
                fastMode: current.sessionFastMode,
                shell,
              })
            }}
            onStop={() => useTeamStore.getState().stopTeam()}
            onSlashCommand={handleSlashCommand}
            onSnippetCommand={handleSnippetCommand}
            slashCommands={slashCommands}
            snippetCommands={snippetCommands}
            historyPrompts={historyPrompts}
            fileRefs={fileRefs}
            onFileRefsNeeded={() => setFileRefsEnabled(true)}
            isStreaming={isTeamWorking}
            disabled={mode === 'coding' && isCodingSessionLoading}
            placeholder={
              dreamMutation.isPending
                ? 'Dream is running…'
                : isTeamWorking
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
            onRedo={() => { void useTeamStore.getState().redoTeam() }}
          />
        )}
        </main>
        {mode === 'coding' && workspace && codingFileViewer !== null && (
          <CodingFileViewerPanel
            workspace={workspace}
            file={codingFileViewer}
            mobile={isMobile}
            onAddComment={handleAddFileComment}
            onClose={() => setCodingFileViewer(null)}
          />
        )}
        {mode === 'coding' && workspace && codingPanel !== null && (
          <CodingWorkspacePanel
            key={codingPanel}
            workspace={workspace}
            open
            initialTab={codingPanel}
            mobile={isMobile}
            selectedFilePath={codingFileViewer?.path ?? null}
            onFileSelect={handleCodingFileSelect}
            onClose={() => {
              setCodingPanel(null)
              setCodingFileViewer(null)
            }}
          />
        )}
      </div>

      <SessionSettingsPanel
        open={agentCapabilitiesOpen}
        agentNames={agentNames}
        workspace={agentWorkspace}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        sessionFastMode={sessionFastMode}
        onSessionModelSettingsChange={setSessionModelSettings}
        onClose={closeAgentCapabilities}
      />
      <WorkspaceFilesPanel
        open={mode !== 'coding' && showFilesPanel}
        sessionId={sessionIdState}
        onClose={() => setShowFilesPanel(false)}
      />
      <TodosPopover
        open={isMobile && showTodos}
        onOpenChange={setShowTodos}
        todos={todos}
        sessionId={sessionIdState}
        trigger={false}
      />
      <WikiPanel open={wikiOpen} onClose={closeWiki} />
      <SchedulerPanel
        open={schedulerOpen}
        onClose={closeScheduler}
        contextMode={mode}
        contextWorkspace={workspace ?? null}
      />
      {showPalette && (
        <CommandPalette commands={paletteCommands} onClose={() => setShowPalette(false)} />
      )}
    </div>
  )
}

// ─── MobileChatActions ─────────────────────────────────────────────────────

function MobileHeaderAction({
  Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  badge = 0,
}: {
  Icon: LucideIcon
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  badge?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors disabled:opacity-45 ${
        active
          ? 'bg-(--bg-key) text-(--color-text)'
          : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)'
      }`}
      aria-label={label}
      title={label}
    >
      <Icon size={16} aria-hidden="true" />
      {badge > 0 && (
        <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-(--color-accent) px-1 text-center font-mono text-[9px] leading-3.5 text-(--bg-page)">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  )
}

interface MobileChatActionsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'normal' | 'coding'
  workspace: string | null
  activeAgent: string | null
  agents: string[]
  streams: Record<string, AgentStream>
  onSelectAgent: (agent: string) => void
  onWiki: () => void
  onScheduler: () => void
  tokens?: {
    input: number
    output: number
    cached: number
    total: number
    pulsing: boolean
  }
}

function MobileChatActions({
  open,
  onOpenChange,
  mode,
  workspace,
  activeAgent,
  agents,
  streams,
  onSelectAgent,
  onWiki,
  onScheduler,
  tokens,
}: MobileChatActionsProps) {
  return (
    <>
      <button
        type="button"
        data-no-drag
        onClick={() => onOpenChange(true)}
        className="mr-1 flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
        aria-label="Open chat actions"
        title="Chat actions"
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="mobile-actions-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-black/60 md:hidden"
              aria-hidden="true"
              onClick={() => onOpenChange(false)}
            />
            <motion.aside
              key="mobile-actions-drawer"
              initial={{ x: 280 }}
              animate={{ x: 0 }}
              exit={{ x: 280 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              className="mobile-safe-top fixed bottom-0 right-0 z-40 flex w-[min(272px,calc(100vw-2rem))] flex-col overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-xl md:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Chat actions"
            >
              <div className="border-b border-(--color-border) px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-(--color-text)">
                      {mode === 'coding' && workspace ? workspaceLabel(workspace) : 'Chat actions'}
                    </p>
                    {activeAgent && (
                      <p className="mt-1 truncate font-mono text-xs text-(--color-text-muted)">Active: {activeAgent}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenChange(false)}
                    className="rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Close chat actions"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2">
                {activeAgent && agents.length > 1 && (
                  <>
                    <div className="px-2 py-2 text-xs font-medium text-muted-foreground">Agents</div>
                    {agents.map((name) => (
                      <button
                        type="button"
                        key={name}
                        onClick={() => { onSelectAgent(name); onOpenChange(false) }}
                        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-(--bg-key)"
                      >
                        <span className={`h-2 w-2 rounded-full ${dotClassFor(name, streams[name])}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
                        {name === activeAgent && <Check size={13} className="text-(--color-accent)" aria-hidden="true" />}
                      </button>
                    ))}
                  </>
                )}

                <div className="px-2 py-2 text-xs font-medium text-muted-foreground">Session</div>
                {tokens && (
                  <div className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm">
                    <span className="flex-1">Tokens</span>
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-(--color-text)">
                      <span title={`Prompt: ${tokens.input.toLocaleString()}`}>in {formatTokens(tokens.input)}</span>
                      <span title={`Output: ${tokens.output.toLocaleString()}`}>out {formatTokens(tokens.output)}</span>
                      {tokens.cached > 0 && <span title={`Cached: ${tokens.cached.toLocaleString()}`}>cache {formatTokens(tokens.cached)}</span>}
                      {tokens.pulsing && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--color-accent)" aria-hidden="true" />}
                    </span>
                  </div>
                )}
                <button type="button" onClick={onWiki} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-(--bg-key)">
                  <Brain size={15} aria-hidden="true" />
                  <span className="flex-1">Wiki</span>
                </button>
                <button type="button" onClick={onScheduler} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-(--bg-key)">
                  <CalendarClock size={15} aria-hidden="true" />
                  <span className="flex-1">Scheduler</span>
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}

// ─── ActiveAgentSwitcher ───────────────────────────────────────────────────
//
// Single chip → dropdown of all members. Replaces the horizontal chip
// carousel that didn't scale past ~4 agents. ``data-no-drag`` on the
// trigger opts it out of ``useTauriDrag``'s interactive guard so the
// chip-as-trigger doesn't race the window-drag handler.

interface ActiveAgentSwitcherProps {
  activeAgent: string
  agents: string[]
  streams: Record<string, AgentStream>
  onSelect: (agent: string) => void
}

const DOT_BY_ROLE: Record<AgentRole, string> = {
  openagentd: 'bg-(--color-marker-mint)',
  executor: 'bg-(--color-marker-orange)',
  consultant: 'bg-(--color-marker-blue)',
  explorer: 'bg-(--color-text-muted)',
}

function dotClassFor(agent: string, stream: AgentStream | undefined): string {
  if (stream?.status === 'error') return 'bg-(--color-error)'
  if (stream?.status === 'working') return 'animate-pulse bg-(--color-accent)'
  if (stream?.status === 'offline') return 'bg-(--color-text-subtle) opacity-50'
  if (isAgentRole(agent)) return DOT_BY_ROLE[agent]
  return 'bg-(--color-success)'
}

function ActiveAgentSwitcher({
  activeAgent,
  agents,
  streams,
  onSelect,
}: ActiveAgentSwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-no-drag
        className="inline-flex h-9 min-w-0 shrink items-center gap-2 rounded-md px-2 font-mono text-xs leading-none font-semibold text-(--color-text) outline-none transition-all hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-accent)/40 sm:h-auto sm:px-3 sm:py-1.5"
        aria-label={`Switch active agent (current: ${activeAgent})`}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${dotClassFor(activeAgent, streams[activeAgent])}`}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{activeAgent}</span>
        <ChevronDown size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
      </DropdownMenuTrigger>

      {/* w-auto overrides w-(--anchor-width) so the menu sizes to its
          content rather than the (narrow) trigger. */}
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-auto max-w-[min(90vw,24rem)]"
      >
        {agents.map((name) => (
          <DropdownMenuItem
            key={name}
            onClick={() => onSelect(name)}
            className="flex min-w-40 items-center gap-2 font-mono text-xs whitespace-nowrap"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${dotClassFor(name, streams[name])}`}
              aria-hidden="true"
            />
            <span>{name}</span>
            {name === activeAgent && (
              <Check size={12} className="ml-auto shrink-0 text-(--color-accent)" aria-hidden="true" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
