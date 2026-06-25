import type { Dispatch, HTMLAttributes, SetStateAction } from 'react'
import { Home, FolderOpen, ListTodo, Menu, SlidersHorizontal } from 'lucide-react'
import type { NavigateFn } from '@tanstack/react-router'

import { AgentTopbar, type AgentTopbarTokens } from '@/components/AgentTopbar'
import { MobileHeaderAction } from './MobileHeaderAction'
import { MobileChatActions } from './MobileChatActions'
import { TodosPopover } from '@/components/TodosPopover'
import { TokenMeter } from '@/components/ui/token-meter'
import type { AgentStream } from '@/stores/useTeamStore'
import type { TodoItem } from '@/api/types'
import type { ViewMode } from './types'
import { workspaceLabel } from '@/utils/workspace'

interface TeamChatHeaderProps {
  dragHandlers: HTMLAttributes<HTMLElement>
  isMacOverlay: boolean
  isMobile: boolean
  mode: 'normal' | 'coding'
  workspace: string | null
  sessionTitle: string | null
  activeAgent: string | null
  effectiveViewMode: ViewMode
  splitAgentCount: number
  navigate: NavigateFn
  onCodingSidebarToggle: () => void
  onMobileSidebarOpen: () => void
  headerTokens?: AgentTopbarTokens
  sessionId: string | null
  todos: TodoItem[]
  showTodos: boolean
  setShowTodos: Dispatch<SetStateAction<boolean>>
  showFilesPanel: boolean
  setShowFilesPanel: Dispatch<SetStateAction<boolean>>
  codingPanel: null | 'changed' | 'files'
  onWorkspaceFiles: () => void
  agentCapabilitiesOpen: boolean
  onToggleAgentCapabilities: () => void
  showMobileActions: boolean
  setShowMobileActions: Dispatch<SetStateAction<boolean>>
  agentNames: string[]
  agentStreams: Record<string, AgentStream>
  onSelectAgent: (agent: string) => void
  onToggleScheduler: () => void
  onCloseMobileActionsMenu: () => void
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
}

export function TeamChatHeader({
  dragHandlers,
  isMacOverlay,
  isMobile,
  mode,
  workspace,
  sessionTitle,
  activeAgent,
  effectiveViewMode,
  splitAgentCount,
  navigate,
  onCodingSidebarToggle,
  onMobileSidebarOpen,
  headerTokens,
  sessionId,
  todos,
  showTodos,
  setShowTodos,
  showFilesPanel,
  setShowFilesPanel,
  codingPanel,
  onWorkspaceFiles,
  agentCapabilitiesOpen,
  onToggleAgentCapabilities,
  showMobileActions,
  setShowMobileActions,
  agentNames,
  agentStreams,
  onSelectAgent,
  onToggleScheduler,
  onCloseMobileActionsMenu,
  viewMode,
  onViewModeChange,
}: TeamChatHeaderProps) {
  const activeTodoCount = todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length

  return (
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
                onCodingSidebarToggle()
              } else if (isMobile) {
                onMobileSidebarOpen()
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

        {/* Agent switching lives in the chat area's member line. Split view
            collapses to a count pill — each pane already shows its
            own agent. */}
        <div className="flex min-w-0 flex-1 justify-start overflow-hidden px-1">
          {isMobile && (
            <div className="min-w-0 text-sm font-semibold text-(--color-text)">
              <div className="truncate">{mode === 'coding' && workspace ? workspaceLabel(workspace) : sessionTitle || 'Cockpit'}</div>
              {activeAgent && <div className="truncate font-mono text-[10px] font-normal text-(--color-text-muted)">{activeAgent}</div>}
            </div>
          )}

          {effectiveViewMode === 'split' && (
            <span className="text-xs text-(--color-text-muted)">
              Split · {splitAgentCount} agents
            </span>
          )}
        </div>

        {/* Right cluster — desktop gets the full action row. Mobile keeps
            frequent actions visible and leaves secondary panels in More. */}
        <div className="flex shrink-0 items-center gap-0.5">
        {isMobile ? (
          <>
            {headerTokens && (
              <TokenMeter
                input={headerTokens.input}
                output={headerTokens.output}
                cached={headerTokens.cached}
                trigger={headerTokens.trigger}
                pulsing={headerTokens.pulsing}
                className="mr-0.5"
              />
            )}
            <MobileHeaderAction
              Icon={ListTodo}
              label="Tasks"
              onClick={() => setShowTodos(true)}
              disabled={!sessionId}
              badge={activeTodoCount}
            />
            <MobileHeaderAction
              Icon={FolderOpen}
              label={mode === 'coding' ? 'Workspace files' : 'Session files'}
              onClick={mode === 'coding'
                ? workspace ? onWorkspaceFiles : undefined
                : sessionId ? () => setShowFilesPanel((v) => !v) : undefined}
              active={mode === 'coding' ? codingPanel !== null : showFilesPanel}
              disabled={mode === 'coding' ? !workspace : !sessionId}
            />
            <MobileHeaderAction
              Icon={SlidersHorizontal}
              label="Agent settings"
              onClick={onToggleAgentCapabilities}
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
              onSelectAgent={onSelectAgent}
              onScheduler={() => { onToggleScheduler(); onCloseMobileActionsMenu() }}
            />
          </>
        ) : (
          <AgentTopbar
            isMobile={false}
            tokens={headerTokens}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            todosSlot={
              <TodosPopover
                open={showTodos}
                onOpenChange={setShowTodos}
                todos={todos}
                sessionId={sessionId}
              />
            }
            filesAction={mode === 'coding'
              ? workspace ? {
                  Icon: FolderOpen,
                  onClick: onWorkspaceFiles,
                  title: codingPanel === null ? 'Changed files and workspace files' : 'Close changed files and workspace files',
                  ariaLabel: 'Changed files and workspace files',
                  className: codingPanel !== null ? 'bg-(--bg-key) text-(--color-text) ring-1 ring-(--color-border-strong)' : undefined,
                } : undefined
              : {
                  Icon: FolderOpen,
                  onClick: () => setShowFilesPanel((v) => !v),
                  disabled: !sessionId,
                  title: sessionId ? 'Workspace files (Ctrl+F)' : 'No active session',
                  ariaLabel: 'Workspace files',
                  className: showFilesPanel ? 'bg-(--bg-key) text-(--color-text) ring-1 ring-(--color-border-strong)' : undefined,
                }}
            agentsAction={{
              Icon: SlidersHorizontal,
              onClick: onToggleAgentCapabilities,
              title: 'Session model settings (Ctrl+A)',
              ariaLabel: 'Session model settings',
              className: agentCapabilitiesOpen ? 'mr-2 bg-(--bg-key) text-(--color-text)' : 'mr-2',
            }}
          />
        )}
        </div>
    </header>
  )
}
