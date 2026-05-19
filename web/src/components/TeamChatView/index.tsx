/**
 * TeamChatView — top-level layout for the team chat route.
 *
 * Owns:
 *   - View-mode state (``agent`` / ``split``).
 *   - Side panels (``Sidebar``, ``WorkspaceFilesPanel``, ``AgentCapabilities``,
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
import OctobotMascot from '@/assets/brand/octobot-agentd-source.png'

import { Link, useNavigate } from '@tanstack/react-router'
import { AgentCapabilities } from '../AgentCapabilities'
import { AgentView } from '../AgentView'
import { WorkspaceInfoCard } from '../WorkspaceInfoCard'
import { CodingSidebar } from '../CodingSidebar'
import { CodingWorkspacePanel } from '../CodingWorkspacePanel'
import { Sidebar } from '../Sidebar'
import { CommandPalette } from '../CommandPalette'
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel'
import { TodosPopover } from '../TodosPopover'
import { WikiPanel } from '../WikiPanel'
import { SchedulerPanel } from '../SchedulerPanel'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useProvidersQuery, useTriggerDreamMutation } from '@/queries'
import { useCommandsQuery } from '@/queries/useCommandsQuery'
import { renderCommand } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { useToastStore } from '@/stores/useToastStore'
import { useUIStore } from '@/stores/useUIStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useTeamAgentsQuery } from '@/queries/useAgentsQuery'
import { useSpeechConfigQuery } from '@/queries/useSpeechConfigQuery'
import { useFileRefsQuery } from '@/queries/useFileRefsQuery'
import { AlertCircle, Check, ChevronDown, FolderOpen, FolderCode, Home, Menu, X } from 'lucide-react'
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
import { type InputBarHandle, type SlashCommand } from '../InputBar'
import { FloatingInputBar } from '../FloatingInputBar'
import type { AgentCapabilities as AgentCapabilitiesType, MessageAttachment } from '@/api/types'
import { SplitGrid } from './SplitGrid'
import { useTeamCommands } from './useTeamCommands'
import { VIEW_MODES, type ViewMode } from './types'
import { saveCodingWorkspace, workspaceLabel } from '@/utils/workspace'
import { setTraySession } from '@/lib/tray'

interface TeamChatViewProps {
  sessionId?: string
  mode?: 'normal' | 'coding'
  workspace?: string | null
}

async function attachmentToFile(att: MessageAttachment): Promise<File | null> {
  if (!att.url) return null
  const res = await fetch(att.url)
  if (!res.ok) return null
  const blob = await res.blob()
  return new File(
    [blob],
    att.original_name ?? att.filename ?? 'attachment',
    { type: att.media_type ?? blob.type },
  )
}

export function TeamChatView({ sessionId, mode = 'normal', workspace = null }: TeamChatViewProps) {
  const navigate = useNavigate()
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
  const [codingPanel, setCodingPanel] = useState<null | 'files' | 'diff'>(null)
  const [codingSidebarCollapsed, setCodingSidebarCollapsed] = useState(false)
  const [openWorkspaceDialogKey, setOpenWorkspaceDialogKey] = useState(0)
  const [showTodos, setShowTodos] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('agent')

  // On mobile, always force agent view — split/unified require a wide screen.
  // Also close any desktop-only panels when shrinking to mobile.
  const effectiveViewMode: ViewMode = isMobile ? 'agent' : viewMode
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
  const newSession     = useTeamStore((s) => s.newSession)
  const cycleActiveAgent = useTeamStore((s) => s.cycleActiveAgent)
  const setActiveAgent   = useTeamStore((s) => s.setActiveAgent)
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

  const { data: todosData } = useTodosQuery(sessionIdState)
  const todos = todosData?.todos ?? []
  const providersQ = useProvidersQuery()
  const hasConfiguredModelProvider = providersQ.data?.providers.some(
    (provider) => provider.kind !== 'local' && provider.is_configured,
  ) ?? true

  // Lead capabilities — used to drive composer affordances (slash menu).
  const agentWorkspace = mode === 'coding' ? workspace : null
  const hasCodingWorkspace = mode !== 'coding' || Boolean(workspace)
  const { data: teamAgentsData, isLoading: teamAgentsLoading } = useTeamAgentsQuery(agentWorkspace, hasCodingWorkspace)
  const leadCapabilities: AgentCapabilitiesType | undefined = teamAgentsData?.agents
    ?.find((a) => a.is_lead)?.capabilities

  // Voice input — enabled flag from /api/speech/config.
  const { data: speechConfig } = useSpeechConfigQuery()
  const voiceEnabled = speechConfig?.enabled ?? false

  // Workspace file/folder list for the InputBar's @-mention picker. Fetched
  // lazily — the query is keyed on workspace/session so coding and normal
  // modes don't share cache entries.
  const { refs: fileRefs } = useFileRefsQuery({
    mode,
    sessionId: sessionIdState,
    workspace,
    enabled: mode === 'coding' ? Boolean(workspace) : Boolean(sessionIdState),
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
      await loadSession(sessionId, agentWorkspace)
      if (cancelled) return
      const controller = connectStream()
      if (controller) abortRef.current = controller
    })()

    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentWorkspace, hasCodingWorkspace])

  // ── Commands / shortcuts ───────────────────────────────────────────────────

  const handleNewSession = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    newSession()
    if (mode === 'coding' && workspace) {
      const entry = saveCodingWorkspace(workspace)
      navigate({ to: '/coding', search: { w: entry.id } })
    } else {
      navigate({ to: mode === 'coding' ? '/coding' : '/cockpit' })
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [mode, workspace, newSession, navigate])

  const handleWorkspaceFiles = useCallback(() => {
    if (mode === 'coding') {
      if (workspace) {
        setCodingPanel((value) => value === null ? 'files' : null)
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

  // Slash commands for the input bar (type / to trigger).
  // Built-ins execute immediately on pick; user-defined commands are inserted
  // into the textarea (``keepInputOpen``) so the user can append
  // ``$ARGUMENTS`` before submitting.
  const commandsQ = useCommandsQuery()
  const userCommandNames = useMemo(
    () => new Set<string>((commandsQ.data?.commands ?? []).map((c) => c.name)),
    [commandsQ.data],
  )
  const slashCommands: SlashCommand[] = [
    { id: 'stop', label: 'Stop', description: 'Stop all working agents' },
    { id: 'continue', label: 'Continue', description: 'Continue the last assistant response' },
    { id: 'compact', label: 'Compact', description: 'Summarize and compact this session' },
    { id: 'undo', label: 'Undo', description: 'Undo the previous message' },
    { id: 'redo', label: 'Redo', description: 'Restore the next undone message' },
    { id: 'new', label: 'New Chat', description: 'Start a fresh team conversation' },
    ...(commandsQ.data?.commands ?? []).map((c) => ({
      id: c.name,
      label: c.name,
      description: c.description || `Custom command (${c.source})`,
      keepInputOpen: true,
    })),
  ]

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
    }
  }, [handleNewSession])

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
        if (userCommandNames.has(candidate)) {
          const argsHead = tokens.slice(n).join(' ')
          const restOfMessage = rest.slice(firstLine.length)
          const args = (argsHead + restOfMessage).trim()
          try {
            const res = await renderCommand(candidate, args)
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
    [userCommandNames, pushToast],
  )

  const cycleViewMode = useCallback(() => {
    setViewMode((v) => {
      const idx = VIEW_MODES.indexOf(v)
      return VIEW_MODES[(idx + 1) % VIEW_MODES.length]
    })
  }, [])

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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // h-dvh handles iOS Safari's dynamic toolbar.
    <div className="flex h-dvh flex-col bg-(--bg-page)">
      {/* 40 px header above the sidebar/content row. On macOS Tauri it
          doubles as the window drag region via useTauriDrag, with a
          70 px left inset reserved for the OS traffic-lights. */}
      <header
        {...dragHandlers}
        className={`flex h-10 items-center border-b border-(--color-border) bg-(--bg-page) ${
          isMacOverlay ? 'select-none pl-[70px]' : ''
        }`}
      >
          {/* Home — 56 px column on desktop to line up with the
              collapsed sidebar; shrinks on mobile and macOS overlay
              (where the parent already provides inset padding). */}
          <div
            className={`flex h-full shrink-0 items-center justify-center ${
              isMacOverlay ? 'pl-2' : 'md:w-14'
            }`}
          >
            <Link
              to="/"
              aria-label="Home"
              title="Home"
              className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
            >
              <Home size={16} aria-hidden="true" />
            </Link>
          </div>

          {/* Hamburger target depends on mode: coding sidebar toggle,
              mobile drawer, or synthetic Ctrl+B for the normal sidebar
              (whose collapse state is owned by Sidebar). */}
          <div className="mr-2 flex shrink-0 items-center gap-1 pl-2 md:pl-0">
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
              className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
            >
              <Menu size={16} aria-hidden="true" />
            </button>
            {mode !== 'coding' && sessionTitle && (
              <span
                className="ml-1 max-w-60 truncate text-sm font-semibold text-(--color-text)"
                title={sessionTitle}
              >
                {sessionTitle}
              </span>
            )}
          </div>

          {/* Active-agent chip → dropdown of all members. Split view
              collapses to a count pill — each pane already shows its
              own agent. */}
          <div className="flex min-w-0 flex-1 justify-start">
            {effectiveViewMode === 'agent' && activeAgent && (
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

          {/* Right cluster — tokens, dream, view toggle, panel
              toggles via the shared AgentTopbar composite. */}
          <div className="flex shrink-0 items-center">
          <AgentTopbar
            isMobile={isMobile}
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
                  className: 'mr-2',
                } : undefined
              : {
                  Icon: FolderOpen,
                  onClick: () => setShowFilesPanel((v) => !v),
                  disabled: !sessionIdState,
                  title: sessionIdState ? 'Workspace files (Ctrl+F)' : 'No active session',
                  ariaLabel: 'Workspace files',
                  className: 'mr-2',
                }}
          />
          </div>
      </header>

      {/* Body row — sidebar (or coding rail) + main content column. On
          mobile the Sidebar is position:fixed (overlay drawer), so it
          takes no space here and the main column is always full-width. */}
      <div className="flex min-h-0 flex-1">
        {mode === 'coding' ? (
          <CodingSidebar
            currentSessionId={sessionIdState || undefined}
            workspace={workspace}
            onCollapse={() => setCodingSidebarCollapsed(true)}
            openWorkspaceDialogKey={openWorkspaceDialogKey}
            onCommandPalette={isMobile ? undefined : () => setShowPalette(true)}
            desktopCollapsed={codingSidebarCollapsed}
            mobileOpen={mobileSidebarOpen}
            onMobileClose={() => setMobileSidebarOpen(false)}
          />
        ) : (
          <Sidebar
            currentSessionId={sessionIdState || undefined}
            onCommandPalette={isMobile ? undefined : () => setShowPalette(true)}
            onNewChat={handleNewSession}
            mobileOpen={mobileSidebarOpen}
            onMobileClose={() => setMobileSidebarOpen(false)}
          />
        )}

        <main id="main" ref={mainColumnRef} className="relative flex min-w-0 flex-1 flex-col">
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
                className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
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
        ) : (
          <div className="flex flex-1 select-none flex-col items-center justify-center gap-3">
            <img src={OctobotMascot} className="opacity-25 grayscale" width={64} height={64} alt="Idle octobot" />
            <p className="text-sm text-(--color-text-muted)">Select an agent above</p>
          </div>
        )}

        <FloatingInputBar
          ref={inputRef}
          boundsRef={mainColumnRef}
          onSubmit={async (content, files) => {
            const expanded = await expandUserCommand(content)
            sendMessage(expanded, files, { mode, workspace })
          }}
          onStop={() => useTeamStore.getState().stopTeam()}
          onSlashCommand={handleSlashCommand}
          slashCommands={slashCommands}
          fileRefs={fileRefs}
          isStreaming={isTeamWorking}
          disabled={mode === 'coding' && !workspace}
          autoFocus={!sessionId}
          placeholder={
            dreamMutation.isPending
              ? 'Dream is running…'
              : isTeamWorking
                ? 'Team working… type to interrupt'
                : mode === 'coding' && workspace
                  ? `Coding in ${workspaceLabel(workspace)}`
                  : mode === 'coding'
                    ? 'Choose a workspace to start coding…'
                    : 'Message the team…'
          }
          capabilities={leadCapabilities}
          voiceEnabled={voiceEnabled}
          revertedCount={leadName ? agentStreams[leadName]?.revertedCount ?? 0 : 0}
          revertedMessages={leadName ? agentStreams[leadName]?.revertedMessages ?? [] : []}
          onRedo={() => { void useTeamStore.getState().redoTeam() }}
        />
        </main>
        {mode === 'coding' && workspace && codingPanel !== null && (
          <CodingWorkspacePanel
            key={codingPanel}
            workspace={workspace}
            open
            initialTab={codingPanel}
            mobile={isMobile}
            onClose={() => setCodingPanel(null)}
          />
        )}
      </div>

      <AgentCapabilities
        open={agentCapabilitiesOpen}
        agentNames={agentNames}
        agentStreams={agentStreams}
        workspace={agentWorkspace}
        onClose={closeAgentCapabilities}
      />
      <WorkspaceFilesPanel
        open={mode !== 'coding' && showFilesPanel}
        sessionId={sessionIdState}
        onClose={() => setShowFilesPanel(false)}
      />
      <WikiPanel open={wikiOpen} onClose={closeWiki} />
      <SchedulerPanel
        open={schedulerOpen}
        onClose={closeScheduler}
        contextMode={mode}
        contextWorkspace={workspace ?? null}
      />
      {!isMobile && showPalette && (
        <CommandPalette commands={commands} onClose={() => setShowPalette(false)} />
      )}
    </div>
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
        className="inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 font-mono text-xs leading-none font-semibold text-(--color-text) outline-none transition-all hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-accent)/40"
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
