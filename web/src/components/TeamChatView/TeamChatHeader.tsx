import { memo, type Dispatch, type HTMLAttributes, type SetStateAction } from 'react'
import { ListTodo, PanelLeft, PanelRight, SlidersHorizontal } from 'lucide-react'

import { AgentTopbar, type AgentTopbarTokens } from '@/components/AgentTopbar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  workspace: string | null
  sessionTitle: string | null
  activeAgent: string | null
  effectiveViewMode: ViewMode
  splitAgentCount: number
  onCodingSidebarToggle: () => void
  headerTokens?: AgentTopbarTokens
  sessionId: string | null
  todos: TodoItem[]
  showTodos: boolean
  setShowTodos: Dispatch<SetStateAction<boolean>>
  codingPanel: null | 'changed' | 'files'
  onWorkspaceFiles: () => void
  agentCapabilitiesOpen: boolean
  onToggleAgentCapabilities: () => void
  showMobileActions: boolean
  setShowMobileActions: Dispatch<SetStateAction<boolean>>
  mobileActionsDragOffset?: number | null
  agentNames: string[]
  agentStreams?: Record<string, AgentStream>
  onSelectAgent: (agent: string) => void
  onToggleScheduler: () => void
  onCloseMobileActionsMenu: () => void
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
}

export const TeamChatHeader = memo(function TeamChatHeader({
  dragHandlers,
  isMacOverlay,
  isMobile,
  workspace,
  sessionTitle,
  activeAgent,
  effectiveViewMode,
  splitAgentCount,
  onCodingSidebarToggle,
  headerTokens,
  sessionId,
  todos,
  showTodos,
  setShowTodos,
  codingPanel,
  onWorkspaceFiles,
  agentCapabilitiesOpen,
  onToggleAgentCapabilities,
  showMobileActions,
  setShowMobileActions,
  mobileActionsDragOffset = null,
  agentNames,
  agentStreams,
  onSelectAgent,
  onToggleScheduler,
  onCloseMobileActionsMenu,
  viewMode: _viewMode,
  onViewModeChange: _onViewModeChange,
}: TeamChatHeaderProps) {
  const activeTodoCount = todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length

  return (
    <header
      {...dragHandlers}
      className={`mobile-safe-header flex h-(--spacing-app-header) shrink-0 items-center overflow-hidden border-b border-(--color-border) bg-(--bg-page) ${
        isMacOverlay ? 'select-none pl-[70px]' : ''
      }`}
    >
        <div className={`mr-1 flex h-full min-w-0 shrink items-center gap-1 pl-2 md:mr-2 ${isMacOverlay ? '' : 'md:pl-3'}`}>
          {/* Hamburger target depends on mode: coding sidebar toggle,
              mobile drawer, or a synthetic ⌘B/Ctrl+B for the general sidebar
              (whose collapse state is owned by Sidebar). */}
          <button
            type="button"
            onClick={() => {
              onCodingSidebarToggle()
            }}
            aria-label="Toggle sidebar"
            className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
          >
            <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          {workspace && !isMobile ? (
            <Tooltip className="ml-1 min-w-0 max-w-xs lg:max-w-md xl:max-w-xl">
              <TooltipTrigger
                className="min-w-0 max-w-xs lg:max-w-md xl:max-w-xl"
                render={
                  <span className="flex min-w-0 max-w-xs items-baseline gap-1 text-sm lg:max-w-md xl:max-w-xl">
                    <span className="shrink-0 font-semibold text-(--color-text)">{workspaceLabel(workspace)}</span>
                    {sessionTitle && (
                      <>
                        <span className="shrink-0 text-(--color-text-muted)">·</span>
                        <span className="truncate text-(--color-text-muted)">{sessionTitle}</span>
                      </>
                    )}
                  </span>
                }
              />
              <TooltipContent>{sessionTitle ? `${workspaceLabel(workspace)}: ${sessionTitle}` : workspace}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        {/* Agent switching lives in the chat area's member line. Split view
            collapses to a count pill — each pane already shows its
            own agent. */}
        <div className="flex min-w-0 flex-1 justify-start overflow-hidden px-1">
          {isMobile && (
            <div className="min-w-0 flex items-baseline gap-1 text-sm">
              {workspace ? (
                <span className="truncate font-semibold text-(--color-text)">{workspaceLabel(workspace)}</span>
              ) : (
                <span className="truncate font-semibold text-(--color-text)">Choose a workspace</span>
              )}
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
        <div className="flex shrink-0 items-center gap-0.5 md:pr-1">
        {isMobile ? (
          <>
            {headerTokens && (
              <TokenMeter
                input={headerTokens.input}
                output={headerTokens.output}
                cached={headerTokens.cached}
                cachedPercent={headerTokens.cachedPercent}
                sessionCostUsd={headerTokens.sessionCostUsd}
                trigger={headerTokens.trigger}
                pulsing={headerTokens.pulsing}
                className="mr-0.5"
              />
            )}
            <MobileHeaderAction
              Icon={ListTodo}
              label="Tasks"
              onClick={() => setShowTodos((v) => !v)}
              disabled={!sessionId}
              badge={activeTodoCount}
              active={showTodos}
            />
            <MobileHeaderAction
              Icon={PanelRight}
              label="Workspace files"
              onClick={workspace ? onWorkspaceFiles : undefined}
              active={codingPanel !== null}
              disabled={!workspace}
            />
            <MobileHeaderAction
              Icon={SlidersHorizontal}
              label="Session settings"
              onClick={onToggleAgentCapabilities}
              active={agentCapabilitiesOpen}
            />
            <MobileChatActions
              open={showMobileActions}
              onOpenChange={setShowMobileActions}
              dragOffset={mobileActionsDragOffset}
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
            todosSlot={
              <TodosPopover
                open={showTodos}
                onOpenChange={setShowTodos}
                todos={todos}
                sessionId={sessionId}
              />
            }
            filesAction={workspace ? {
                  Icon: PanelRight,
                  onClick: onWorkspaceFiles,
                  title: codingPanel === null ? 'Changed files and workspace files' : 'Close changed files and workspace files',
                  ariaLabel: 'Changed files and workspace files',
                  className: codingPanel !== null ? 'border border-(--color-border-strong) bg-(--bg-key) text-(--color-text)' : undefined,
                } : undefined}
          />
        )}
        </div>
    </header>
  )
})
