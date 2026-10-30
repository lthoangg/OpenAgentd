import { memo, useState, type Dispatch, type HTMLAttributes, type SetStateAction } from 'react'
import { AnimatedTitle } from '@/components/ui/animated-title'
import { isFreshAutoTitle } from '@/lib/auto-title'
import { cn } from '@/lib/utils'
import { ListTodo, PanelLeft, PanelRight } from 'lucide-react'

import { AgentTopbar, type AgentTopbarTokens } from '@/components/AgentTopbar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { MobileHeaderAction } from './MobileHeaderAction'
import { MobileChatActions } from './MobileChatActions'
import { CommandCenterButton } from './CommandCenterButton'
import { summarizeTodos } from '@/components/TaskChecklist'
import type { GoalHeaderState } from '@/lib/work'
import type { CodingWorkspaceTreeChat, TodoItem } from '@/api/types'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { workspaceLabel } from '@/utils/workspace'

interface AgentChatHeaderProps {
  dragHandlers: HTMLAttributes<HTMLElement>
  isMacOverlay: boolean
  isMobile: boolean
  workspace: string | null
  /** Chat entry from the workspace tree — labels the chat root as "Chat". */
  chatWorkspace?: CodingWorkspaceTreeChat | null
  sessionTitle: string | null
  onSidebarToggle: () => void
  headerTokens?: AgentTopbarTokens
  sessionId: string | null
  todos: TodoItem[]
  /** ⌘T target: the dock's Tasks tab on desktop, the popover otherwise. */
  onToggleTasks: () => void
  /** Whether the task list is showing (popover open, or Tasks tab focused). */
  tasksViewActive: boolean
  /** The session's live goal: its ring and tooltip sit on the Task list button. */
  goalState?: GoalHeaderState | null
  workspacePanel: null | 'changed' | 'files'
  onWorkspaceFiles: () => void
  agentCapabilitiesOpen: boolean
  onToggleAgentCapabilities: () => void
  showMobileActions: boolean
  setShowMobileActions: Dispatch<SetStateAction<boolean>>
  mobileActionsDragOffset?: number | null
  onToggleScheduler: () => void
  onOpenTerminal?: () => void
  onCloseMobileActionsMenu: () => void
  /** Desktop command center and the mobile drawer's palette row; hidden or disabled when omitted. */
  onOpenPalette?: () => void
  /** Mobile drawer's file search; disabled when omitted (no workspace). */
  onQuickOpen?: () => void
}

export const AgentChatHeader = memo(function AgentChatHeader({
  dragHandlers,
  isMacOverlay,
  isMobile,
  workspace,
  chatWorkspace = null,
  sessionTitle,
  onSidebarToggle,
  headerTokens,
  sessionId,
  todos,
  onToggleTasks,
  tasksViewActive,
  goalState = null,
  workspacePanel,
  onWorkspaceFiles,
  agentCapabilitiesOpen,
  onToggleAgentCapabilities,
  showMobileActions,
  setShowMobileActions,
  mobileActionsDragOffset = null,
  onToggleScheduler,
  onOpenTerminal,
  onCloseMobileActionsMenu,
  onOpenPalette,
  onQuickOpen,
}: AgentChatHeaderProps) {
  const { os } = usePlatform()
  // Published by the mounted transcript; a new chat has no prompts to step.
  const publishedJumpToPrompt = useTranscriptFollowStore((s) => s.jumpToPrompt)
  const jumpToPrompt = sessionId ? publishedJumpToPrompt : null
  const activeTodoCount = todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length
  const todoSummary = summarizeTodos(todos)
  // The chat workspace reads as "Chat" rather than the home directory's
  // basename, on every label derived from the workspace path.
  const isChatWorkspace = isChatWorkspacePath(workspace, chatWorkspace)
  const workspaceName = workspace ? workspaceLabel(workspace, chatWorkspace) : ''
  // The tooltip exists to disambiguate a truncated basename (two workspaces can
  // share one), so it keeps revealing the real path for project workspaces —
  // but never the home path for chat, whose label is already unambiguous.
  const workspaceTooltip = isChatWorkspace ? workspaceName : workspace
  const dockOpen = workspacePanel !== null
  const sidebarShortcut = shortcutLabel(APP_SHORTCUTS.sidebar, os)
  const dockShortcut = shortcutLabel(APP_SHORTCUTS.workspaceFiles, os)

  return (
    <header
      {...dragHandlers}
      // Desktop zoning (dark only): the header joins the sidebar and status
      // bar on the recessed rail tone; light mode keeps one page tone.
      className={`mobile-safe-header flex h-(--spacing-app-header) shrink-0 items-center overflow-hidden border-b border-(--color-border) bg-(--bg-page) md:dark:bg-(--bg-sidebar) ${
        isMacOverlay ? 'select-none pl-[70px]' : ''
      }`}
    >
        <div className={`mr-1 flex h-full min-w-0 shrink items-center gap-1 pl-2 md:mr-2 ${isMacOverlay ? '' : 'md:pl-3'}`}>
          {/* Toggles the desktop sidebar, or the drawer on mobile. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => {
                    onSidebarToggle()
                  }}
                  aria-label="Toggle sidebar"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7 max-md:pointer-coarse:size-9"
                >
                  <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>{`Toggle sidebar (${sidebarShortcut})`}</TooltipContent>
          </Tooltip>
          {/* Read-only: sessions are renamed from their sidebar row. */}
          {workspace && !isMobile ? (
            <Tooltip className="ml-1 min-w-0 max-w-xs lg:max-w-md xl:max-w-xl">
              <TooltipTrigger
                className="min-w-0 max-w-xs lg:max-w-md xl:max-w-xl"
                render={
                  <span className="flex min-w-0 max-w-xs items-baseline gap-1 text-sm lg:max-w-md xl:max-w-xl">
                    <span className="shrink-0 font-semibold text-(--color-text)">{workspaceName}</span>
                    {sessionTitle && (
                      <>
                        <TitleSeparator sessionId={sessionId} title={sessionTitle} />
                        <AnimatedTitle text={sessionTitle} sessionId={sessionId} className="text-(--color-text-muted)" />
                      </>
                    )}
                  </span>
                }
              />
              <TooltipContent>{sessionTitle ? `${workspaceName}: ${sessionTitle}` : workspaceTooltip}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        {/* Center: mobile title, or the desktop command-center search. */}
        <div className="flex min-w-0 flex-1 justify-start overflow-hidden px-1 md:justify-center">
          {isMobile ? (
            // Phones: the session first, its workspace under it.
            <div className="flex min-w-0 flex-col justify-center leading-tight">
              {!workspace ? (
                <span className="truncate text-sm font-semibold text-(--color-text)">Choose a workspace</span>
              ) : (
                <>
                  <span className="truncate text-sm font-semibold text-(--color-text)">
                    {sessionTitle ? <AnimatedTitle text={sessionTitle} sessionId={sessionId} /> : sessionId ? 'Untitled session' : 'New session'}
                  </span>
                  <span className="truncate text-[11px] text-(--color-text-muted)">{workspaceName}</span>
                </>
              )}
            </div>
          ) : onOpenPalette ? (
            <CommandCenterButton onClick={onOpenPalette} />
          ) : null}
        </div>

        {/* Right cluster — desktop gets the full action row. Mobile keeps
            frequent actions visible and leaves secondary panels in More. */}
        <div className="flex shrink-0 items-center gap-0.5 md:pr-1">
        {isMobile ? (
          <>
            <MobileHeaderAction
              Icon={PanelRight}
              label="Review panel"
              onClick={workspace ? onWorkspaceFiles : undefined}
              active={workspacePanel !== null}
              disabled={!workspace}
            />
            <MobileChatActions
              open={showMobileActions}
              onOpenChange={setShowMobileActions}
              dragOffset={mobileActionsDragOffset}
              title={workspace ? (sessionTitle ?? (sessionId ? 'Untitled session' : 'New session')) : 'Choose a workspace'}
              subtitle={workspace ? workspaceName : null}
              onTasks={sessionId ? () => { onCloseMobileActionsMenu(); if (!tasksViewActive) onToggleTasks() } : undefined}
              openTasks={activeTodoCount}
              goalTone={goalState?.tone}
              goalText={goalState?.text ?? null}
              onSessionSettings={() => { onCloseMobileActionsMenu(); if (!agentCapabilitiesOpen) onToggleAgentCapabilities() }}
              tokens={headerTokens}
              onScheduler={() => { onToggleScheduler(); onCloseMobileActionsMenu() }}
              onOpenTerminal={onOpenTerminal ? () => { onOpenTerminal(); onCloseMobileActionsMenu() } : undefined}
              onPreviousPrompt={jumpToPrompt ? () => { jumpToPrompt(-1); onCloseMobileActionsMenu() } : undefined}
              onNextPrompt={jumpToPrompt ? () => { jumpToPrompt(1); onCloseMobileActionsMenu() } : undefined}
              onQuickOpen={onQuickOpen ? () => { onQuickOpen(); onCloseMobileActionsMenu() } : undefined}
              onCommandPalette={onOpenPalette ? () => { onOpenPalette(); onCloseMobileActionsMenu() } : undefined}
            />
          </>
        ) : (
          <AgentTopbar
            isMobile={false}
            tokens={headerTokens}
            todosAction={{
              Icon: ListTodo,
              onClick: onToggleTasks,
              disabled: !sessionId,
              title: sessionId
                ? `${goalState ? `${goalState.text} · ` : ''}Task list (${shortcutLabel(APP_SHORTCUTS.tasks, os)})`
                : 'No active session',
              ariaLabel: 'Task list',
              badge: todoSummary.progressLabel,
              indicator: todoSummary.hasInProgress,
              goalTone: goalState?.tone,
              indicatorClassName: 'bg-(--color-info)',
              pressed: tasksViewActive,
              className: tasksViewActive ? 'bg-(--bg-key) text-(--color-text)' : undefined,
            }}
            filesAction={workspace ? {
                  Icon: PanelRight,
                  onClick: onWorkspaceFiles,
                  title: `${dockOpen ? 'Close' : 'Open'} review dock (${dockShortcut})`,
                  ariaLabel: 'Changed files and workspace files',
                  pressed: dockOpen,
                  className: dockOpen ? 'bg-(--bg-key) text-(--color-text)' : undefined,
                } : undefined}
          />
        )}
        </div>
    </header>
  )
})

/** The "·" before the title; fades in with a first title as it lands. */
function TitleSeparator({ sessionId, title }: { sessionId: string | null | undefined; title: string }) {
  const [landing] = useState(() => isFreshAutoTitle(sessionId, title))
  return <span className={cn('shrink-0 text-(--color-text-muted)', landing && 'oa-fade-in')}>·</span>
}
