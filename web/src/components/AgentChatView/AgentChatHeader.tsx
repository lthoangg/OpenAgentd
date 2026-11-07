import { memo, useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/queries/keys'
import { getCodingWorkspaceStatus } from '@/api/client'
import { AnimatedTitle } from '@/components/ui/animated-title'
import { isFreshAutoTitle } from '@/lib/auto-title'
import { cn } from '@/lib/utils'
import { CornerUpLeft, ListTodo, Menu, PanelLeft, PanelRight } from 'lucide-react'
import { BottomSheet } from '@/components/ui/bottom-sheet'

import { AgentTopbar } from '@/components/AgentTopbar'
import { usePanelWidthSink } from '@/components/ResizableAside'
import { PhoneNavBar } from '@/components/phone/PhoneNavBar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { hasWindowCaption, usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { createAltTapDetector, hasAppMenuButton, showAppMenu } from '@/lib/native-menu'
import { MobileHeaderAction } from './MobileHeaderAction'
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
   * Opens the main agent's session. Set only for a subagent's session: the
   * header then carries a way back, whatever the composer area shows.
   */
  onOpenLead?: () => void
  onSidebarToggle: () => void
  /**
   * A phone's navigation stack: ‹ Sessions replaces the sidebar toggle and
   * the bar takes iOS's layout (see PhoneNavBar).
   */
  onBack?: () => void
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
}

/**
 * The macOS traffic lights' inset is one token, ``--spacing-mac-traffic-inset``
 * (index.css, shared with MacTitleBar). The sidebar toggle sits one 8px gap
 * past it, in the desktop cap and on the phone bar alike (there the bar takes
 * the inset and the left cluster's ``pl-2`` is the gap), so its glyph lands in
 * the same place on both.
 */
const MAC_TOGGLE_INSET_CLASS = 'pl-[calc(var(--spacing-mac-traffic-inset)+0.5rem)]'

/**
 * The 32px buttons that lead the header ring inside their box: the header is
 * 36px and clips overflow, so the outline 2px out lost its top and bottom.
 */
const HEADER_LEAD_FOCUS = 'focus-visible:ring-inset'

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
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={open}
            aria-label="Application menu"
            aria-haspopup="menu"
            className={HEADER_LEAD_FOCUS}
          >
            <Menu size={14} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        }
      />
      <TooltipContent>Application menu (Alt)</TooltipContent>
    </Tooltip>
  )
}

/** ↰ in a subagent's header: one click back to the main agent's session. */
function OpenLeadButton({ onOpen, className }: { onOpen: () => void; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onOpen}
            aria-label="Open the main agent"
            data-open-lead=""
            className={cn(HEADER_LEAD_FOCUS, className)}
          >
            <CornerUpLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        }
      />
      <TooltipContent>Open the main agent</TooltipContent>
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
  onOpenLead,
  onSidebarToggle,
  onBack,
  sessionId,
  todos,
  onToggleTasks,
  tasksViewActive,
  goalState = null,
  workspacePanel,
  onWorkspaceFiles,
}: AgentChatHeaderProps) {
  const platform = usePlatform()
  const { os } = platform
  // Windows: this header is the title bar, and the page's caption buttons
  // (WindowCaptionButtons, fixed at the top right) take its last 3 × 46px.
  const captionInset = hasWindowCaption(platform)
  // The dock cap takes the live width of the Review panel (index.css → Header caps).
  const dockCapRef = usePanelWidthSink('--oa-dock-w')
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
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                onSidebarToggle()
              }}
              aria-label="Toggle sidebar"
              className={HEADER_LEAD_FOCUS}
            >
              {/* Phones open a drawer (menu); desktop folds a rail (panel). */}
              {isMobile ? (
                <Menu size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </Button>
          }
        />
        <TooltipContent>{`Toggle sidebar (${sidebarShortcut})`}</TooltipContent>
      </Tooltip>
    </>
  )

  if (!isMobile) {
    return (
      // Desktop: the title sits right after the sidebar toggle whatever the
      // sidebar does; the Review panel's cap is as wide as its panel
      // (geometry in index.css → Header caps).
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
          data-header-cap="sidebar"
          // The traffic lights sit over the sidebar, as in a native app; the
          // toggle keeps a native gap from them (they end near 66px). The cap
          // is only as wide as its buttons: it does not follow the sidebar.
          className={cn('flex shrink-0 items-center gap-1 pr-1', isMacOverlay ? MAC_TOGGLE_INSET_CLASS : 'pl-3')}
        >
          {leadButtons}
        </div>
        {/* The title over the chat, then the Review panel's cap. The command
            palette has no button: ⌘K and the View menu open it. */}
        <div data-header-main="" className="flex min-w-0 flex-1 items-stretch">
          {/* Workspace · session, read-only: sessions are renamed from the
              sidebar, and a double-click here maximizes the window. */}
          <div className="flex min-w-0 flex-1 items-center pr-2 pl-3">
            {onOpenLead && <OpenLeadButton onOpen={onOpenLead} className="mr-1.5" />}
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
                      key={sessionId ?? 'new'}
                      sessionId={sessionId}
                      title={sessionTitle}
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
              todosAction={{
                Icon: ListTodo,
                onClick: onToggleTasks,
                disabled: !sessionId,
                title: sessionId
                  ? `${goalState ? `${goalState.text} · ` : ''}Tasks (${shortcutLabel(APP_SHORTCUTS.tasks, os)})`
                  : 'No active session',
                ariaLabel: 'Tasks',
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

  const tasksAction = (
    <MobileHeaderAction
      Icon={ListTodo}
      label={activeTodoCount > 0 ? `Tasks, ${activeTodoCount} open` : 'Tasks'}
      tooltip={goalState ? `${goalState.text} · Tasks` : 'Tasks'}
      onClick={sessionId ? onToggleTasks : undefined}
      active={tasksViewActive}
      disabled={!sessionId}
      badge={activeTodoCount}
      goalTone={goalState?.tone}
    />
  )
  const reviewAction = (
    <MobileHeaderAction
      Icon={PanelRight}
      label="Review panel"
      onClick={workspace ? onWorkspaceFiles : undefined}
      active={workspacePanel !== null}
      disabled={!workspace}
    />
  )

  if (onBack) {
    return (
      <PhoneChatNavBar
        onBack={onBack}
        workspace={workspace}
        workspaceName={workspaceName}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        onOpenLead={onOpenLead}
        actions={<>{tasksAction}{reviewAction}</>}
      />
    )
  }

  return (
    <header
      {...dragHandlers}
      // Phones: one bar, the middle given to the title. Its bottom line shows
      // only once the transcript scrolls under it (``data-transcript-scrolled``
      // on the shell, from AgentView), like an iOS navigation bar.
      className={cn(
        'mobile-safe-header grid h-(--spacing-app-header) shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center overflow-hidden border-b border-transparent bg-(--bg-page) transition-colors duration-(--motion-fast) in-data-[transcript-scrolled]:border-(--color-border) md:dark:bg-(--bg-sidebar)',
        isMacOverlay && 'select-none pl-(--spacing-mac-traffic-inset)',
        captionInset && 'select-none pr-[138px]',
      )}
    >
        <div className={`mr-1 flex h-full min-w-0 items-center gap-1 pl-2 md:mr-2 ${isMacOverlay ? '' : 'md:pl-3'}`}>
          {leadButtons}
          {onOpenLead && <OpenLeadButton onOpen={onOpenLead} />}
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

        {/* Right cluster, as on desktop: the task list, then the Review panel,
            whose "+" menu holds terminal, find file and scheduled tasks. Its
            pr-2 mirrors the left cluster's pl-2. */}
        <div data-header-cluster="end" className="flex min-w-0 items-center justify-self-end gap-0.5 pr-2 md:pr-1">
            {tasksAction}
            {reviewAction}
        </div>
    </header>
  )
})

/** The "·" before the title; fades in with a first title as it lands. */
function TitleSeparator({ sessionId, title }: { sessionId: string | null | undefined; title: string }) {
  const [landing] = useState(() => isFreshAutoTitle(sessionId, title))
  return <span className={cn('shrink-0 text-(--color-text-muted)', landing && 'oa-fade-in')}>·</span>
}

/**
 * The phone stack's chat bar: ‹ Sessions, the title left-aligned (a tap
 * opens the session's info, with its branch), then Tasks and Workspace as
 * direct buttons.
 */
function PhoneChatNavBar({ onBack, workspace, workspaceName, sessionId, sessionTitle, onOpenLead, actions }: {
  onBack: () => void
  workspace: string | null
  workspaceName: string
  sessionId: string | null | undefined
  sessionTitle: string | null
  onOpenLead?: () => void
  actions: ReactNode
}) {
  const [infoOpen, setInfoOpen] = useState(false)
  const { data: status } = useQuery({
    queryKey: queryKeys.coding.status(workspace ?? ''),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace!, signal),
    enabled: !!workspace && infoOpen,
  })
  const branch = status?.is_git_repo ? status.branch : null
  const titleText = !workspace
    ? 'Choose a workspace'
    : sessionTitle ? <AnimatedTitle text={sessionTitle} sessionId={sessionId} /> : sessionId ? 'Untitled session' : 'New session'
  return (
    <>
      <PhoneNavBar
        separator="scrolled"
        titleAlign="start"
        back={{ label: 'Sessions', onBack }}
        title={sessionId ? (
          <Button
            type="button"
            variant="ghost"
            data-session-info-trigger=""
            onClick={() => setInfoOpen(true)}
            aria-label="Session info"
            // The bar's own title type: the button only adds the tap. No
            // phone button floor (``min-h-0!``): its 40px box under the
            // workspace line pushed the title up and the bar taller, and the
            // ghost's muted medium text read as a second subtitle. ``!``
            // throughout: ``cn`` does not merge, so these must beat the
            // ghost/size classes they repeat.
            className="block! h-auto! min-h-0! min-w-0! max-w-full truncate rounded-none! p-0! text-left font-semibold! text-[length:inherit]! leading-[inherit]! text-(--color-text)! hover:bg-transparent! active:bg-transparent! active:opacity-60"
          >
            {titleText}
          </Button>
        ) : titleText}
        subtitle={workspace ? workspaceName : undefined}
        trailing={(
          <div data-header-cluster="end" className="flex items-center">
            {onOpenLead && <OpenLeadButton onOpen={onOpenLead} />}
            {actions}
          </div>
        )}
      />
      <BottomSheet open={infoOpen} onClose={() => setInfoOpen(false)} label="Session info">
        <dl data-session-info="" className="flex flex-col px-4 pb-4 text-sm">
          <div className="flex min-h-11 items-center justify-between gap-4 border-b border-(--color-border) last:border-b-0">
            <dt className="text-(--color-text-muted)">Title</dt>
            <dd className="min-w-0 truncate text-(--color-text)">{sessionTitle || 'Untitled session'}</dd>
          </div>
          {workspace && (
            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-(--color-border) last:border-b-0">
              <dt className="text-(--color-text-muted)">Workspace</dt>
              <dd className="min-w-0 truncate text-(--color-text)" title={workspace}>{workspaceName}</dd>
            </div>
          )}
          {branch && (
            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-(--color-border) last:border-b-0">
              <dt className="text-(--color-text-muted)">Branch</dt>
              <dd data-session-branch="" className="min-w-0 truncate font-mono text-(--color-text)" title={branch}>{branch}</dd>
            </div>
          )}
        </dl>
      </BottomSheet>
    </>
  )
}
