/**
 * TeamChatView — top-level layout for the team chat route.
 *
 * Owns:
 *   - View-mode state (``agent`` / ``split`` / ``unified``).
 *   - Side panels (``Sidebar``, ``WorkspaceFilesPanel``, ``AgentCapabilities``,
 *     todos popover, command palette).
 *   - The header (token totals, view toggle, panel toggles, agent tabs).
 *   - Mount-time SSE connect + session restore (carefully sequenced so
 *     ``loadSession`` runs *before* ``connectStream`` to avoid wiping
 *     replayed mid-turn state — see comment inside the init effect).
 *   - Keyboard shortcuts and the Command Palette assembly.
 *
 * Delegates:
 *   - ``SplitGrid``     — fixed n-pane grid layout (split mode).
 *   - ``AgentTabStrip`` — unified-mode tab strip.
 *   - ``TileArea``      — recursive tile tree (unified mode).
 *   - ``usePanelDnD``   — split-mode drag-to-reorder state.
 *   - ``useTeamCommands`` — Command Palette command list.
 *
 * Stream subscriptions are split into the smallest selectors that work
 * (one primitive per ``useTeamStore`` call) to avoid the infinite loop
 * that returning a freshly-built object on every render would trigger.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import OctobotMascot from '@/assets/brand/octobot-agentd-source.png'

import { useNavigate } from '@tanstack/react-router'
import { AgentCapabilities } from '../AgentCapabilities'
import { AgentView } from '../AgentView'
import { Sidebar } from '../Sidebar'
import { CommandPalette } from '../CommandPalette'
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTodosQuery } from '@/queries/useTodosQuery'
import { useTriggerDreamMutation } from '@/queries'
import { useTeamStore } from '@/stores/useTeamStore'
import { useToastStore } from '@/stores/useToastStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useTileLayout } from '@/hooks/useTileLayout'
import { useTeamAgentsQuery } from '@/queries/useAgentsQuery'
import { useSpeechConfigQuery } from '@/queries/useSpeechConfigQuery'
import {
  Maximize2,
  LayoutGrid,
  Layers,
  Users,
  FolderOpen,
  SplitSquareHorizontal,
  SplitSquareVertical,
  ListTodo,
  Menu,
  Moon,
} from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { formatTokens } from '@/utils/format'
import { type InputBarHandle, type SlashCommand } from '../InputBar'
import { FloatingInputBar } from '../FloatingInputBar'
import type { AgentCapabilities as AgentCapabilitiesType } from '@/api/types'
import { SplitGrid } from './SplitGrid'
import { AgentTabStrip } from './AgentTabStrip'
import { TileArea } from './TileArea'
import { usePanelDnD } from './usePanelDnD'
import { useTeamCommands } from './useTeamCommands'
import { VIEW_MODES, type ViewMode } from './types'

interface TeamChatViewProps {
  sessionId?: string
}

export function TeamChatView({ sessionId }: TeamChatViewProps) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const inputRef = useRef<InputBarHandle>(null)
  const mainColumnRef = useRef<HTMLDivElement>(null)
  const [showAgentSidebar, setShowAgentSidebar] = useState(false)
  const [showFilesPanel, setShowFilesPanel] = useState(false)
  const [showTodos, setShowTodos] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('agent')

  // On mobile, always force agent view — split/unified require a wide screen.
  // Also close any desktop-only panels when shrinking to mobile.
  const effectiveViewMode: ViewMode = isMobile ? 'agent' : viewMode
  useEffect(() => {
    if (isMobile) {
      setShowAgentSidebar(false)
      setShowFilesPanel(false)
    }
  }, [isMobile])

  const connectStream  = useTeamStore((s) => s.connectStream)
  const loadTeamStatus = useTeamStore((s) => s.loadTeamStatus)
  const loadSession    = useTeamStore((s) => s.loadSession)
  const sendMessage    = useTeamStore((s) => s.sendMessage)
  const newSession     = useTeamStore((s) => s.newSession)
  const cycleActiveAgent = useTeamStore((s) => s.cycleActiveAgent)
  const setActiveAgent   = useTeamStore((s) => s.setActiveAgent)

  const dreamMutation = useTriggerDreamMutation()
  const pushToast = useToastStore((s) => s.push)

  const activeAgent    = useTeamStore((s) => s.activeAgent)
  const agentStreams   = useTeamStore((s) => s.agentStreams)
  const agentNames     = useTeamStore((s) => s.agentNames)
  const isTeamWorking  = useTeamStore((s) => s.isTeamWorking)
  const sessionIdState = useTeamStore((s) => s.sessionId)
  const leadName       = useTeamStore((s) => s.leadName)

  // Subscribe to active-agent stream fields directly to avoid recomputing on
  // every other agent's tick.
  const activeBlocks        = useTeamStore((s) => s.activeAgent ? s.agentStreams[s.activeAgent]?.blocks : undefined)
  const activeCurrentBlocks = useTeamStore((s) => s.activeAgent ? s.agentStreams[s.activeAgent]?.currentBlocks : undefined)
  const activeStatus        = useTeamStore((s) => s.activeAgent ? s.agentStreams[s.activeAgent]?.status : undefined)

  const { data: todosData } = useTodosQuery(sessionIdState)
  const todos = todosData?.todos ?? []

  // Lead capabilities — used to drive composer affordances (slash menu).
  const { data: teamAgentsData } = useTeamAgentsQuery()
  const leadCapabilities: AgentCapabilitiesType | undefined = teamAgentsData?.agents
    ?.find((a) => a.is_lead)?.capabilities

  // Voice input — enabled flag from /api/speech/config.
  const { data: speechConfig } = useSpeechConfigQuery()
  const voiceEnabled = speechConfig?.enabled ?? false

  // Sum tokens — four primitive selectors, no new object returned (avoids infinite loop).
  const totalPrompt     = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.promptTokens, 0))
  const totalCompletion = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.completionTokens, 0))
  const totalCached     = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.cachedTokens, 0))
  const totalAll        = useTeamStore((s) => Object.values(s.agentStreams).reduce((n, st) => n + st.usage.totalTokens, 0))

  const abortRef = useRef<AbortController | null>(null)

  // ── Tile layout (unified view only) ────────────────────────────────────────

  const tileLayout = useTileLayout({
    sessionId: sessionIdState,
    leadName,
    agentNames,
  })

  const { openAgents, focusedAgent, openAgent, splitRight, splitDown, closeAgent, focusAgent } = tileLayout

  // ── Init / reconnect ───────────────────────────────────────────────────────

  useEffect(() => {
    loadTeamStatus()
    if (!sessionId) return
    const store = useTeamStore.getState()
    if (store.sessionId === sessionId && store.isConnected) return

    useTeamStore.setState({ sessionId })

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
      await loadSession(sessionId)
      if (cancelled) return
      const controller = connectStream()
      if (controller) abortRef.current = controller
    })()

    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ── Split-view drag-to-reorder ─────────────────────────────────────────────

  const dnd = usePanelDnD({ agentNames, leadName })

  // ── Commands / shortcuts ───────────────────────────────────────────────────

  const handleNewSession = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    newSession()
    navigate({ to: '/cockpit' })
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [newSession, navigate])

  const handleDreamRun = useCallback(() => {
    dreamMutation.mutate(undefined, {
      onSuccess: (result) => {
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

  // Slash commands for the input bar (type / to trigger)
  const slashCommands: SlashCommand[] = [
    { id: 'stop', label: 'Stop', description: 'Stop all working agents' },
    { id: 'new', label: 'New Chat', description: 'Start a fresh team conversation' },
  ]

  const handleSlashCommand = useCallback((id: string) => {
    switch (id) {
      case 'stop':
        useTeamStore.getState().stopTeam()
        break
      case 'new':
        handleNewSession()
        break
    }
  }, [handleNewSession])

  const cycleViewMode = useCallback(() => {
    setViewMode((v) => {
      const idx = VIEW_MODES.indexOf(v)
      return VIEW_MODES[(idx + 1) % VIEW_MODES.length]
    })
  }, [])

  // Unified-mode split actions — cycle through minimized agents
  // Ctrl+J = split down (new pane below focused)
  // Ctrl+K = split right (new pane to the right of focused)
  const minimizedAgents = agentNames.filter((n) => !openAgents.includes(n))

  const handleSplitDown = useCallback(() => {
    if (!focusedAgent) return
    const target = minimizedAgents[0]
    if (!target) return
    splitDown(focusedAgent, target)
  }, [focusedAgent, minimizedAgents, splitDown])

  const handleSplitRight = useCallback(() => {
    if (!focusedAgent) return
    const target = minimizedAgents[0]
    if (!target) return
    splitRight(focusedAgent, target)
  }, [focusedAgent, minimizedAgents, splitRight])

  const handleClosePane = useCallback(() => {
    if (focusedAgent) closeAgent(focusedAgent)
  }, [focusedAgent, closeAgent])

  const commands = useTeamCommands({
    viewMode,
    cycleViewMode,
    setViewMode,
    setShowAgentSidebar,
    setShowFilesPanel,
    setShowTodos,
    handleNewSession,
    handleDreamRun,
    agentNames,
    leadName,
    openAgents,
    focusedAgent,
    cycleActiveAgent,
    setActiveAgent,
    focusAgent,
    openAgent,
    handleSplitDown,
    handleSplitRight,
    handleClosePane,
    navigate,
  })

  useKeyboardShortcuts({
    n: handleNewSession,
    v: isMobile ? undefined : cycleViewMode,
    j: effectiveViewMode === 'unified' ? handleSplitDown  : undefined,
    k: effectiveViewMode === 'unified' ? handleSplitRight : undefined,
    w: effectiveViewMode === 'unified' ? handleClosePane  : undefined,
    a: () => setShowAgentSidebar((v) => !v),
    f: () => { if (sessionIdState) setShowFilesPanel((v) => !v) },
    t: () => { if (sessionIdState) setShowTodos((v) => !v) },
    p: isMobile ? undefined : () => setShowPalette((v) => !v),
    // Ctrl+I — focus the chat input (dispatched via CustomEvent so future
    // callers don't need a ref to the input).
    'i': () => window.dispatchEvent(new CustomEvent('focus-chat-input')),
  })

  // Tab / Shift+Tab — agent view: cycle store activeAgent; unified: cycle open panes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      if (effectiveViewMode === 'unified') {
        if (openAgents.length === 0) return
        const idx = focusedAgent ? openAgents.indexOf(focusedAgent) : -1
        const next = e.shiftKey
          ? (idx - 1 + openAgents.length) % openAgents.length
          : (idx + 1) % openAgents.length
        focusAgent(openAgents[next])
      } else {
        cycleActiveAgent(e.shiftKey ? 'prev' : 'next')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [effectiveViewMode, openAgents, focusedAgent, focusAgent, cycleActiveAgent])

  // ── Derived ────────────────────────────────────────────────────────────────

  const effectivePanelOrder = dnd.panelOrder.length > 0 ? dnd.panelOrder : agentNames

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // h-dvh: accounts for iOS Safari's dynamic toolbar (h-screen is too tall)
    <div className="flex h-dvh bg-(--color-bg)">
      {/* On mobile the Sidebar is position:fixed (overlay drawer), so it takes
          no space in this flex row — the main column is always full-width. */}
      <Sidebar
        currentSessionId={sessionIdState || undefined}
        onCommandPalette={isMobile ? undefined : () => setShowPalette(true)}
        onNewChat={handleNewSession}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />

      <div ref={mainColumnRef} className="relative flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-1 border-b border-(--color-border) bg-(--color-bg) px-2 py-0 md:gap-0 md:px-4">

          {/* Mobile: hamburger to open sidebar drawer */}
          {isMobile && (
            <button
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="Open navigation"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-accent-subtle) hover:text-(--color-text)"
            >
              <Menu size={16} aria-hidden="true" />
            </button>
          )}

          {/* Left: agent tabs (agent view) or unified tab strip */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {effectiveViewMode === 'agent' && agentNames.map((name) => {
              const stream = agentStreams[name]
              const isActive = activeAgent === name
              const isWorking = stream?.status === 'working'
              return (
                <button
                  key={name}
                  onClick={() => setActiveAgent(name)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-(--color-accent-subtle) text-(--color-accent)'
                      : 'text-(--color-text-muted) hover:bg-(--color-accent-dim) hover:text-(--color-text-2)'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    isWorking ? 'animate-pulse bg-(--color-accent)'
                    : stream?.status === 'error' ? 'bg-(--color-error)'
                    : 'bg-(--color-success)'
                  }`} />
                  {name}
                   {name === leadName && <span className="text-(--color-text-subtle)">·</span>}
                </button>
              )
            })}

            {effectiveViewMode === 'split' && (
              <span className="text-xs text-(--color-text-muted)">
                Split · {effectivePanelOrder.length} agents · drag to reorder
              </span>
            )}

            {effectiveViewMode === 'unified' && (
              <AgentTabStrip
                agentNames={agentNames}
                agentStreams={agentStreams}
                leadName={leadName}
                openAgents={openAgents}
                focusedAgent={focusedAgent}
                onFocusOpen={focusAgent}
                onOpenMinimized={openAgent}
                onClose={closeAgent}
              />
            )}
          </div>

          {/* Right: tokens (desktop) + view toggle (desktop) + panel toggles */}
          <div className="flex shrink-0 items-center gap-1.5 py-2">

            {/* Token count — desktop only, too noisy on mobile */}
            {!isMobile && totalAll > 0 && (
              <div
                className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-(--color-text-muted)"
                title={`Prompt: ${totalPrompt.toLocaleString()} · Output: ${totalCompletion.toLocaleString()}${totalCached > 0 ? ` · Cached: ${totalCached.toLocaleString()}` : ''}`}
              >
                <span className="text-(--color-text-muted)">tokens</span>
                <span className="font-mono text-(--color-text-2)">
                  {formatTokens(totalPrompt)}
                  <span className="mx-0.5 text-(--color-text-subtle)">/</span>
                  {formatTokens(totalCompletion)}
                  {totalCached > 0 && (
                    <>
                      <span className="mx-0.5 text-(--color-text-subtle)">/</span>
                      <span className="text-(--color-syn-operator)">{formatTokens(totalCached)}</span>
                    </>
                  )}
                </span>
                {isTeamWorking && (
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-(--color-accent)" />
                )}
              </div>
            )}

            {/* Dream running indicator */}
            {dreamMutation.isPending && (
              <div
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-(--color-text-muted)"
                title="Dream is running…"
              >
                <Moon size={11} className="animate-pulse" aria-hidden="true" />
                <span className="hidden sm:inline">Dream…</span>
              </div>
            )}

            {/* Unified-view split buttons — desktop only */}
            {!isMobile && effectiveViewMode === 'unified' && minimizedAgents.length > 0 && (
              <div className="flex items-center gap-0.5">
                <button onClick={handleSplitDown} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-(--color-text-muted) transition-colors hover:bg-(--color-accent-dim) hover:text-(--color-text-2)" title="Split pane down (Ctrl+J)" aria-label="Split pane down">
                  <SplitSquareVertical size={12} aria-hidden="true" />
                </button>
                <button onClick={handleSplitRight} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-(--color-text-muted) transition-colors hover:bg-(--color-accent-dim) hover:text-(--color-text-2)" title="Split pane right (Ctrl+K)" aria-label="Split pane right">
                  <SplitSquareHorizontal size={12} aria-hidden="true" />
                </button>
              </div>
            )}

            {/* 3-way view toggle — desktop only. Mobile always uses agent view. */}
            {!isMobile && (
              <div className="flex items-center rounded-lg border border-(--color-border) bg-(--color-bg) p-0.5">
                <button
                  onClick={() => setViewMode('agent')}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-all ${viewMode === 'agent' ? 'bg-(--color-accent-subtle) text-(--color-accent)' : 'text-(--color-text-muted) hover:text-(--color-text-2)'}`}
                  title="Agent view (Ctrl+V)"
                  aria-label="Agent view"
                  aria-pressed={viewMode === 'agent'}
                >
                  <Maximize2 size={12} aria-hidden="true" />Agent
                </button>
                <button
                  onClick={() => setViewMode('split')}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-all ${viewMode === 'split' ? 'bg-(--color-accent-subtle) text-(--color-accent)' : 'text-(--color-text-muted) hover:text-(--color-text-2)'}`}
                  title="Split view (Ctrl+V)"
                  aria-label="Split view"
                  aria-pressed={viewMode === 'split'}
                >
                  <LayoutGrid size={12} aria-hidden="true" />Split
                </button>
                <button
                  onClick={() => setViewMode('unified')}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-all ${viewMode === 'unified' ? 'bg-(--color-accent-subtle) text-(--color-accent)' : 'text-(--color-text-muted) hover:text-(--color-text-2)'}`}
                  title="Unified view (Ctrl+V)"
                  aria-label="Unified view"
                  aria-pressed={viewMode === 'unified'}
                >
                  <Layers size={12} aria-hidden="true" />Unified
                </button>
              </div>
            )}

            <Popover open={showTodos} onOpenChange={setShowTodos}>
              <PopoverTrigger
                disabled={!sessionIdState}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-(--color-text-muted) transition-colors hover:bg-(--color-accent-dim) hover:text-(--color-text-2) disabled:cursor-not-allowed disabled:opacity-50"
                title={sessionIdState ? 'Task list (Ctrl+T)' : 'No active session'}
                aria-label="Task list"
              >
                <ListTodo size={13} aria-hidden="true" />
                <span className="hidden md:inline">Todos</span>
                {todos.some((t) => t.status === 'in_progress') && (
                  <span className="size-1.5 rounded-full bg-(--color-accent)" />
                )}
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-80 p-0">
                <div className="flex items-center justify-between border-b border-(--color-border) px-3 py-2">
                  <span className="text-xs font-semibold text-(--color-text)">Tasks</span>
                  {todos.length > 0 && (
                    <span className="text-[10px] text-(--color-text-subtle)">
                      {todos.filter((t) => t.status === 'completed').length}/{todos.length} done
                    </span>
                  )}
                </div>
                {todos.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-(--color-text-subtle)">No tasks yet</p>
                ) : (
                  <ul className="max-h-80 overflow-y-auto py-1">
                    {[...todos].sort((a, b) => {
                        const order = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 }
                        return order[a.status] - order[b.status]
                      }).map((todo) => (
                      <li key={todo.task_id} className="flex items-start gap-2 px-3 py-1.5">
                        <span className="mt-0.5 shrink-0 text-[10px]">
                          {todo.status === 'completed' ? '✓' : todo.status === 'cancelled' ? '✗' : todo.status === 'in_progress' ? '▶' : '○'}
                        </span>
                        <span className={`flex-1 text-xs leading-snug ${todo.status === 'completed' || todo.status === 'cancelled' ? 'text-(--color-text-subtle) line-through' : 'text-(--color-text)'}`}>
                          {todo.content}
                        </span>
                        <span className={`shrink-0 self-start rounded px-1 py-0.5 text-[9px] font-medium uppercase ${todo.priority === 'high' ? 'bg-red-500/10 text-red-500' : todo.priority === 'low' ? 'bg-(--color-accent-dim) text-(--color-text-subtle)' : 'bg-amber-500/10 text-amber-500'}`}>
                          {todo.priority}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </PopoverContent>
            </Popover>

            <button
              onClick={() => setShowFilesPanel((v) => !v)}
              disabled={!sessionIdState}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-(--color-text-muted) transition-colors hover:bg-(--color-accent-dim) hover:text-(--color-text-2) disabled:cursor-not-allowed disabled:opacity-50"
              title={sessionIdState ? 'Workspace files (Ctrl+F)' : 'No active session'}
              aria-label="Workspace files"
            >
              <FolderOpen size={13} aria-hidden="true" />
              <span className="hidden md:inline">Files</span>
            </button>

            <button
              onClick={() => setShowAgentSidebar((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-(--color-text-muted) transition-colors hover:bg-(--color-accent-dim) hover:text-(--color-text-2)"
              title="Agent Capabilities (Ctrl+A)"
              aria-label="Agent capabilities"
            >
              <Users size={13} aria-hidden="true" />
              <span className="hidden md:inline">Agents</span>
            </button>
          </div>
        </header>

        {/* Content area */}
        {effectiveViewMode === 'split' && effectivePanelOrder.length > 0 ? (
          <div className="min-h-0 flex-1 p-3">
            <SplitGrid
              panelOrder={effectivePanelOrder}
              leadName={leadName}
              agentStreams={agentStreams}
              draggingIdx={dnd.draggingIdx}
              dropTargetIdx={dnd.dropTargetIdx}
              onDragStart={dnd.onDragStart}
              onDragOver={dnd.onDragOver}
              onDrop={dnd.onDrop}
              onDragEnd={dnd.onDragEnd}
            />
          </div>
        ) : effectiveViewMode === 'unified' ? (
          <TileArea
            tileLayout={tileLayout}
            agentStreams={agentStreams}
            leadName={leadName}
          />
        ) : activeAgent && agentStreams[activeAgent] ? (
          <AgentView
            blocks={activeBlocks ?? agentStreams[activeAgent].blocks}
            currentBlocks={activeCurrentBlocks ?? agentStreams[activeAgent].currentBlocks}
            isWorking={(activeStatus ?? agentStreams[activeAgent].status) === 'working'}
            isError={(activeStatus ?? agentStreams[activeAgent].status) === 'error'}
            lastError={agentStreams[activeAgent].lastError}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <img src={OctobotMascot} className="opacity-25 grayscale" width={64} height={64} alt="Idle octobot" />
            <p className="text-sm text-(--color-text-muted)">Select an agent above</p>
          </div>
        )}

        <FloatingInputBar
          ref={inputRef}
          boundsRef={mainColumnRef}
          onSubmit={(content, files) => sendMessage(content, files)}
          onStop={() => useTeamStore.getState().stopTeam()}
          onSlashCommand={handleSlashCommand}
          slashCommands={slashCommands}
          isStreaming={isTeamWorking}
          disabled={false}
          autoFocus={!sessionId}
          placeholder={
            dreamMutation.isPending
              ? 'Dream is running…'
              : isTeamWorking
                ? 'Team working… type to interrupt'
                : 'Message the team…'
          }
          capabilities={leadCapabilities}
          voiceEnabled={voiceEnabled}
        />
      </div>

      <AgentCapabilities
        open={showAgentSidebar}
        agentNames={agentNames}
        agentStreams={agentStreams}
        onClose={() => setShowAgentSidebar(false)}
      />
      <WorkspaceFilesPanel
        open={showFilesPanel}
        sessionId={sessionIdState}
        onClose={() => setShowFilesPanel(false)}
      />
      {!isMobile && showPalette && (
        <CommandPalette commands={commands} onClose={() => setShowPalette(false)} />
      )}
    </div>
  )
}
