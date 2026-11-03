import { memo, useCallback, useEffect, useRef, useState, type Dispatch, type HTMLAttributes, type SetStateAction } from 'react'
import { AnimatedTitle } from '@/components/ui/animated-title'
import { isFreshAutoTitle } from '@/lib/auto-title'
import { cn } from '@/lib/utils'
import { ListTodo, Menu, PanelLeft, PanelRight } from 'lucide-react'

import { AgentTopbar, type AgentTopbarTokens } from '@/components/AgentTopbar'
import { usePanelWidthSink } from '@/components/ResizableAside'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { hasWindowCaption, usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { createAltTapDetector, hasAppMenuButton, showAppMenu } from '@/lib/native-menu'
import { useUpdateSessionTitleMutation } from '@/queries/useSessionsQuery'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { useToastStore } from '@/stores/useToastStore'
import { MobileHeaderAction } from './MobileHeaderAction'
import { MobileChatActions } from './MobileChatActions'
import { HeaderSessionTitle } from './HeaderSessionTitle'
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
  /**
   * Whether the desktop title renames on double-click / F2. False for a
   * subagent's session, which the sidebar does not rename either; phones
   * rename from the drawer and never show the field.
   */
  canRenameSession?: boolean
  onSidebarToggle: () => void
  /** Context use for the phone's More sheet; the run deck's ring shows it everywhere else. */
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
  showMobileActions: boolean
  setShowMobileActions: Dispatch<SetStateAction<boolean>>
  mobileActionsDragOffset?: number | null
  onToggleScheduler: () => void
  onOpenTerminal?: () => void
  onCloseMobileActionsMenu: () => void
  /** The phone More sheet's palette row; hidden when omitted (desktop opens it from the keyboard and menus). */
  onOpenPalette?: () => void
  /** Mobile drawer's file search; disabled when omitted (no workspace). */
  onQuickOpen?: () => void
}

/**
 * ☰: the application menu where the OS menu bar is hidden (Windows, Linux),
 * opened at the button's bottom-left. A bare Alt tap opens it there too, the
 * way those platforms open a menu bar. A narrow window uses the phone layout,
 * whose ☰ is the sidebar drawer, so the button hides and Alt still works.
 */
function AppMenuButton({ hidden }: { hidden: boolean }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const opening = useRef(false)
  const open = useCallback(() => {
    if (opening.current) return
    opening.current = true
    const rect = buttonRef.current?.getBoundingClientRect()
    void showAppMenu({ x: rect?.left ?? 8, y: rect?.bottom ?? 36 }).finally(() => {
      opening.current = false
    })
  }, [])
  useEffect(() => {
    const alt = createAltTapDetector(open)
    // Capture: a handler further in that stops the event must not hide the key.
    window.addEventListener('keydown', alt.onKeyDown, true)
    window.addEventListener('keyup', alt.onKeyUp, true)
    window.addEventListener('pointerdown', alt.onPointerDown, true)
    window.addEventListener('blur', alt.onBlur)
    return () => {
      window.removeEventListener('keydown', alt.onKeyDown, true)
      window.removeEventListener('keyup', alt.onKeyUp, true)
      window.removeEventListener('pointerdown', alt.onPointerDown, true)
      window.removeEventListener('blur', alt.onBlur)
    }
  }, [open])
  if (hidden) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={buttonRef}
            type="button"
            onClick={open}
            aria-label="Application menu"
            aria-haspopup="menu"
            className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7 pointer-coarse:size-9"
          >
            <Menu size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        }
      />
      <TooltipContent>Application menu (Alt)</TooltipContent>
    </Tooltip>
  )
}

export const AgentChatHeader = memo(function AgentChatHeader({
  dragHandlers,
  isMacOverlay,
  isMobile,
  workspace,
  chatWorkspace = null,
  sessionTitle,
  canRenameSession = true,
  onSidebarToggle,
  headerTokens,
  sessionId,
  todos,
  onToggleTasks,
  tasksViewActive,
  goalState = null,
  workspacePanel,
  onWorkspaceFiles,
  showMobileActions,
  setShowMobileActions,
  mobileActionsDragOffset = null,
  onToggleScheduler,
  onOpenTerminal,
  onCloseMobileActionsMenu,
  onOpenPalette,
  onQuickOpen,
}: AgentChatHeaderProps) {
  const platform = usePlatform()
  const { os } = platform
  // Windows: this header is the title bar, and the page's caption buttons
  // (WindowCaptionButtons, fixed at the top right) take its last 3 × 46px.
  const captionInset = hasWindowCaption(platform)
  // The caps take the live widths of the sidebar and the Review panel (index.css → Header caps).
  const sidebarCapRef = usePanelWidthSink('--oa-sidebar-w')
  const dockCapRef = usePanelWidthSink('--oa-dock-w')
  // The sidebar's mutation, so a rename here shows in both at once.
  const { mutate: mutateSessionTitle } = useUpdateSessionTitleMutation()
  const pushToast = useToastStore((s) => s.push)
  const renameSession = useCallback(
    (id: string, title: string) => {
      mutateSessionTitle({ id, title }, { onError: () => pushToast({ tone: 'error', title: 'Could not rename session' }) })
    },
    [mutateSessionTitle, pushToast],
  )
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

  const leadButtons = (
    <>
          {hasAppMenuButton() && <AppMenuButton hidden={isMobile} />}
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
                  className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7 pointer-coarse:size-9"
                >
                  {/* Phones open a drawer (menu); desktop folds a rail (panel). */}
                  {isMobile ? (
                    <Menu size={14} strokeWidth={1.8} aria-hidden="true" />
                  ) : (
                    <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
                  )}
                </button>
              }
            />
            <TooltipContent>{`Toggle sidebar (${sidebarShortcut})`}</TooltipContent>
          </Tooltip>
    </>
  )

  if (!isMobile) {
    return (
      // Desktop: the header splits where the columns below it do (caps as
      // wide as the sidebar and the Review panel; geometry in index.css →
      // Header caps), so both read as columns from the top of the window.
      <header
        {...dragHandlers}
        // Zoning (dark only): the header joins the sidebar and status bar on
        // the recessed rail tone; light mode keeps one page tone. Its bottom
        // line runs the full width, over the sidebar too: one bar.
        className={cn(
          'mobile-safe-header flex h-(--spacing-app-header) shrink-0 items-stretch overflow-hidden border-b border-(--color-border) bg-(--bg-page) md:dark:bg-(--bg-sidebar)',
          (isMacOverlay || captionInset) && 'select-none',
        )}
      >
        <div
          ref={sidebarCapRef}
          data-header-cap="sidebar"
          // The traffic lights sit over the sidebar, as in a native app; the
          // toggle keeps a native gap from them (they end near 66px).
          className={cn('oa-header-cap-sidebar flex shrink-0 items-center gap-1 pr-1', isMacOverlay ? 'pl-[80px]' : 'pl-3')}
        >
          {leadButtons}
        </div>
        {/* The title over the chat, then the Review panel's cap. The command
            palette has no button: ⌘K and the View menu open it. */}
        <div data-header-main="" className="flex min-w-0 flex-1 items-stretch">
          {/* Workspace · session. Double-click the session (or F2 on it) to
              rename it here too; phones rename from the drawer. */}
          <div className="flex min-w-0 flex-1 items-center pr-2 pl-3">
            {workspace ? (
              <div className="flex min-w-0 max-w-xs items-baseline gap-1 text-sm lg:max-w-md xl:max-w-xl">
                <Tooltip className="shrink-0">
                  <TooltipTrigger render={<span className="font-semibold text-(--color-text)">{workspaceName}</span>} />
                  <TooltipContent>{workspaceTooltip}</TooltipContent>
                </Tooltip>
                {sessionTitle && (
                  <>
                    <TitleSeparator sessionId={sessionId} title={sessionTitle} />
                    <HeaderSessionTitle
                      // A new session starts closed: no field carries over.
                      key={sessionId ?? 'new'}
                      sessionId={sessionId}
                      title={sessionTitle}
                      onRename={canRenameSession && sessionId ? (title) => renameSession(sessionId, title) : undefined}
                    />
                  </>
                )}
              </div>
            ) : null}
          </div>
          <div
            ref={dockCapRef}
            data-header-cap="dock"
            // Windows: this header is the title bar, and the page's caption
            // buttons (fixed at the top right) take its last 3 × 46px.
            className={cn('oa-header-cap-dock flex shrink-0 items-center justify-end gap-0.5 pl-1', captionInset ? 'pr-[138px]' : 'pr-1')}
          >
            <AgentTopbar
              isMobile={false}
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
                indicatorClassName: 'bg-(--color-text-2)',
                pressed: tasksViewActive,
                className: tasksViewActive ? 'bg-(--bg-key) text-(--color-text)' : undefined,
              }}
              filesAction={workspace ? {
                    Icon: PanelRight,
                    onClick: onWorkspaceFiles,
                    title: `${dockOpen ? 'Hide' : 'Show'} Review panel (${dockShortcut})`,
                    ariaLabel: 'Review panel',
                    pressed: dockOpen,
                    className: dockOpen ? 'bg-(--bg-key) text-(--color-text)' : undefined,
                  } : undefined}
            />
          </div>
        </div>
      </header>
    )
  }

  return (
    <header
      {...dragHandlers}
      // Phones: one bar, the middle given to the title.
      className={cn(
        'mobile-safe-header grid h-(--spacing-app-header) shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center overflow-hidden border-b border-(--color-border) bg-(--bg-page) md:dark:bg-(--bg-sidebar)',
        isMacOverlay && 'select-none pl-[70px]',
        captionInset && 'select-none pr-[138px]',
      )}
    >
        <div className={`mr-1 flex h-full min-w-0 items-center gap-1 pl-2 md:mr-2 ${isMacOverlay ? '' : 'md:pl-3'}`}>
          {leadButtons}
        </div>

        {/* Center: the session first, its workspace under it. */}
        <div className="flex min-w-0 justify-start overflow-hidden px-1">
            <div className="flex min-w-0 flex-col justify-center leading-tight">
              {!workspace ? (
                <span className="truncate text-sm font-semibold text-(--color-text)">Choose a workspace</span>
              ) : (
                <>
                  <span className="truncate text-sm font-semibold text-(--color-text)">
                    {sessionTitle ? <AnimatedTitle text={sessionTitle} sessionId={sessionId} /> : sessionId ? 'Untitled session' : 'New session'}
                  </span>
                  <span className="truncate text-meta text-(--color-text-muted)">{workspaceName}</span>
                </>
              )}
            </div>
        </div>

        {/* Right cluster: frequent actions stay visible, secondary panels
            live in More. */}
        <div className="flex min-w-0 items-center justify-self-end gap-0.5 md:pr-1">
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
              tokens={headerTokens}
              onScheduler={() => { onToggleScheduler(); onCloseMobileActionsMenu() }}
              onOpenTerminal={onOpenTerminal ? () => { onOpenTerminal(); onCloseMobileActionsMenu() } : undefined}
              onPreviousPrompt={jumpToPrompt ? () => { jumpToPrompt(-1); onCloseMobileActionsMenu() } : undefined}
              onNextPrompt={jumpToPrompt ? () => { jumpToPrompt(1); onCloseMobileActionsMenu() } : undefined}
              onQuickOpen={onQuickOpen ? () => { onQuickOpen(); onCloseMobileActionsMenu() } : undefined}
              onCommandPalette={onOpenPalette ? () => { onOpenPalette(); onCloseMobileActionsMenu() } : undefined}
            />
        </div>
    </header>
  )
})

/** The "·" before the title; fades in with a first title as it lands. */
function TitleSeparator({ sessionId, title }: { sessionId: string | null | undefined; title: string }) {
  const [landing] = useState(() => isFreshAutoTitle(sessionId, title))
  return <span className={cn('shrink-0 text-(--color-text-muted)', landing && 'oa-fade-in')}>·</span>
}
