// Not compiled, as when this code was part of Sidebar, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
/**
 * The workspace tree: Chat, then each repository as a row (the chevron
 * folds, the name opens its latest session, the worktree chip picks a
 * checkout, + and ⋯ act on it) over the sessions of its checkouts. Also the
 * tree's load error, empty state, loading rows and workspace-group filter.
 */
import type { Dispatch, SetStateAction } from 'react'
import { ChevronRight, Folder, FolderPlus, GitBranch, Loader2, MessageCircle, MoreHorizontal, Plus } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { sessionWorking } from '@/lib/active-sessions'
import { cn } from '@/lib/utils'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { workspaceLabel } from '@/utils/workspace'
import { Button } from '@/components/ui/button'
import { Collapsible } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { LongPressButton } from '@/components/ui/long-press-button'
import { ROW_ACTION, ROW_TEXT_ACTION, rowActionsReveal } from '@/components/ui/list-row'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CountChip } from './CountChip'
import { groupColor } from './groupColor'
import { checkoutCountLabel, orderWorkspacePaths, repositoryCheckouts, sessionActivityTime, sourceWorkspacePaths } from './helpers'
import { MissingBadge } from './MissingBadge'
import { SessionStatusMark } from './SessionStatusMark'
import { SidebarLoadError } from './SidebarLoadError'
import { TREE_INDENT_PX } from './tree-indent'
import type { SessionActions } from './useSessionActions'
import { NO_GROUPS, type WorkspaceTreeState } from './useWorkspaceTree'
import type { WorkspaceMenuTarget } from './WorkspaceActionsMenu'
import { WorkspaceGroupDots, workspaceGroupsLabel } from './WorkspaceGroupDots'
import { WorkspaceSessionList } from './WorkspaceSessionList'

export function WorkspaceTree({
  tree,
  onOpenWorkspace,
  sessionsByWorkspace,
  removedWorktreePaths,
  worktreeRemoving,
  checkoutFilter,
  selectCheckout,
  checkoutMenuRepo,
  setCheckoutMenu,
  activeWorkspace,
  activeWorktreeSource,
  expandedWorkspaces,
  toggleWorkspaceExpanded,
  pendingWorkspace,
  openWorkspaceLatest,
  newSessionIn,
  setMobileWorkspaceActions,
  setDesktopWorkspaceActions,
  isMobile,
  mobileLongPressActions,
  currentSessionId,
  showDetails,
  draftWorkspace,
  editingSessionId,
  sessionRowHandlers,
}: {
  tree: WorkspaceTreeState
  onOpenWorkspace: () => void
  sessionsByWorkspace: Map<string, SessionResponse[]>
  /** Worktrees deleted here, kept off the rows while a stale tree lists them. */
  removedWorktreePaths: Set<string>
  /** The worktree being deleted, whose repository's chip spins. */
  worktreeRemoving: string | null
  /** Repository path → the one checkout its list shows. */
  checkoutFilter: Record<string, string>
  selectCheckout: (repository: string, checkout: string | null) => void
  /** The repository whose checkout menu is open. */
  checkoutMenuRepo: string | undefined
  setCheckoutMenu: (menu: { repo: string; x: number; y: number }) => void
  activeWorkspace: string | null
  activeWorktreeSource: string | null | undefined
  expandedWorkspaces: Set<string>
  toggleWorkspaceExpanded: (path: string) => void
  /** A folder from Open workspace… still being added, whose row spins. */
  pendingWorkspace: string | null
  openWorkspaceLatest: (path: string, listPaths: readonly string[], sessionTarget: string) => Promise<void>
  newSessionIn: (path: string) => void
  setMobileWorkspaceActions: Dispatch<SetStateAction<(WorkspaceMenuTarget & { kind: 'main' | 'chat' }) | null>>
  setDesktopWorkspaceActions: Dispatch<SetStateAction<(WorkspaceMenuTarget & { x: number; y: number }) | null>>
  isMobile: boolean
  mobileLongPressActions: boolean
  currentSessionId?: string
  showDetails: boolean
  draftWorkspace: string | null
  editingSessionId: string | null
  sessionRowHandlers: SessionActions['sessionRowHandlers']
}) {
  const {
    workspaceTreeFailed,
    workspaceTreePending,
    workspaceTreeRetrying,
    refetchWorkspaceTree,
    workspaceTree,
    workspaceByPath,
    workspaceGroups,
    groupsOf,
    activeGroupFilter,
    chatWorkspace,
    isChatPath,
    visibleWorkspaces,
  } = tree
  const setGroupFilter = useSidebarViewStore((s) => s.setGroupFilter)

  // Chat, then repositories in a workspace group, then the rest; each part
  // most recently active first.
  const sourceWorkspaces = [
    ...(chatWorkspace ? [chatWorkspace.path] : []),
    ...orderWorkspacePaths(
      sourceWorkspacePaths(workspaceTree, removedWorktreePaths)
        .filter((path) => !isChatPath(path))
        .filter((path) => !activeGroupFilter || (workspaceByPath.get(path)?.group_ids ?? []).includes(activeGroupFilter.id)),
      workspaceByPath,
      workspaceGroups.map((group) => group.id),
      sessionsByWorkspace,
    ),
  ]

  return (
    <div className="flex flex-1 flex-col pb-2">
      {workspaceTreeFailed && workspaceTree.length === 0 && (
        <SidebarLoadError
          title="Couldn't load workspaces."
          retrying={workspaceTreeRetrying}
          onRetry={() => { void refetchWorkspaceTree() }}
          className="px-3 py-1.5"
        />
      )}

      {!workspaceTreePending && !workspaceTreeFailed && visibleWorkspaces.length === 0 && (
        <EmptyState
          compact
          icon={FolderPlus}
          title="No workspaces yet"
          body="A workspace is a folder the agent works in."
          className="px-3 py-3"
          action={(
            <Button type="button" size="sm" onClick={() => { onOpenWorkspace() }}>
              <FolderPlus size={13} aria-hidden="true" />
              Open workspace…
            </Button>
          )}
        />
      )}

      {activeGroupFilter && (
        // The group filter, named above the list, with a one-step way back.
        <div className="mx-1.5 flex h-6 items-center gap-1.5 px-1.5 text-meta text-(--color-text-subtle) pointer-coarse:h-9" data-sidebar-group-filter="">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: groupColor(activeGroupFilter) }} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            Group: <span className="font-mono text-(--color-text-2)">{activeGroupFilter.name}</span>
          </span>
          <button
            type="button"
            onClick={() => setGroupFilter(null)}
            className={ROW_TEXT_ACTION}
            aria-label="Show all workspaces"
          >
            Show all
          </button>
        </div>
      )}

      {sourceWorkspaces.map((path) => {
        // Chat is pinned and not a repository: no worktrees, no rename, no
        // removal — only the expand toggle and "New session" apply.
        const sourceIsChat = isChatPath(path)
        const sourceLabel = sourceIsChat ? (chatWorkspace?.name ?? path) : workspaceLabel(path)
        const sourceGroups = sourceIsChat ? NO_GROUPS : groupsOf(path)
        const checkouts = repositoryCheckouts(path, workspaceByPath.get(path), removedWorktreePaths, checkoutFilter[path])
        const { worktrees, selectedWorktree } = checkouts
        const allCheckoutPaths = [path, ...worktrees.map((item) => item.path)]
        // "New session" starts where the list points: the selected checkout.
        const sessionTarget = checkouts.selected ?? path
        const sourceIsActive = path === activeWorkspace || path === activeWorktreeSource
        const sourceIsExpanded = expandedWorkspaces.has(path)
        const sourceIsPending = pendingWorkspace !== null && allCheckoutPaths.includes(pendingWorkspace)
        const worktreeIsRemoving = worktreeRemoving !== null && allCheckoutPaths.includes(worktreeRemoving)
        const sourceRunningSessions = checkouts.listPaths
          .flatMap((checkout) => sessionsByWorkspace.get(checkout) ?? [])
          .filter(sessionWorking)
          .sort((a, b) => (sessionActivityTime(b) ?? '').localeCompare(sessionActivityTime(a) ?? ''))
        const sourceHasRunningSession = sourceRunningSessions.length > 0
        // Touch: the row says when a session inside waits or runs, so a
        // folded workspace still shows it (mockup J2).
        const sourceWaitingCount = checkouts.listPaths
          .flatMap((checkout) => sessionsByWorkspace.get(checkout) ?? [])
          .filter((session) => session.needs_input === true).length
        const sourceMissing = Boolean(workspaceByPath.get(path)?.missing)
        const worktreeChipHint = checkouts.selected
          ? `Showing ${selectedWorktree?.name ?? 'the workspace'} only · change worktree`
          : `Showing the workspace and ${checkoutCountLabel(worktrees).replace(' · ', ' and ')}`

        return (
          <div key={path} className="relative" data-sidebar-workspace-group="">
            <div className="group mx-1.5 flex h-(--spacing-list-row) items-center rounded-sm hover:bg-(--bg-key)/40">
              {/* The chevron folds; the name opens. Keyboard users fold with
                  ←/→ on the name, so the chevron is not a Tab stop. Its
                  padding keeps it over the session guide below. */}
              <button
                type="button"
                tabIndex={-1}
                data-sidebar-workspace-toggle=""
                onClick={() => toggleWorkspaceExpanded(path)}
                className="flex h-full shrink-0 items-center rounded-sm pl-1.5 pr-1 text-(--color-text-muted) hover:text-(--color-text) pointer-coarse:pr-4.75"
                aria-expanded={sourceIsExpanded}
                aria-label={`${sourceIsExpanded ? 'Collapse' : 'Expand'} workspace ${sourceLabel}`}
              >
                <ChevronRight size={12} className={`shrink-0 transition-transform duration-(--motion-fast) ${sourceIsExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
              </button>
              <Tooltip className="h-full min-w-0 flex-1">
                <TooltipTrigger
                  className="h-full min-w-0 flex-1"
                  render={
                    <LongPressButton
                      enabled={mobileLongPressActions}
                      // Chat gets the sheet too, just a narrower one: on
                      // touch the inline "+" is hidden, so this is the only
                      // way left to start a new chat session.
                      onLongPress={() => setMobileWorkspaceActions({ path, sessionPath: sessionTarget, kind: sourceIsChat ? 'chat' : 'main' })}
                      type="button"
                      data-sidebar-workspace=""
                      onClick={() => { void openWorkspaceLatest(path, checkouts.listPaths, sessionTarget) }}
                      onKeyDown={(event) => {
                        const expandKey = event.key === 'ArrowRight' && !sourceIsExpanded
                        const collapseKey = event.key === 'ArrowLeft' && sourceIsExpanded
                        if (expandKey || collapseKey) {
                          event.preventDefault()
                          toggleWorkspaceExpanded(path)
                        }
                      }}
                      onContextMenu={(event) => {
                        if (mobileLongPressActions || sourceIsChat) return
                        event.preventDefault()
                        setDesktopWorkspaceActions({ path, sessionPath: sessionTarget, x: event.clientX, y: event.clientY })
                      }}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 truncate rounded-sm pr-1.5 text-left text-xs"
                      aria-label={`Open workspace ${sourceLabel}`}
                      aria-description={sourceIsExpanded ? 'Expanded' : 'Collapsed'}
                    >
                      {sourceIsChat ? (
                        <MessageCircle size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                      ) : (
                        <Folder size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                      )}
                      {/* A folder that is gone reads muted, with a ⚠ after it
                          (its tooltip says where it was). */}
                      <span
                        className={cn(
                          'truncate',
                          sourceIsActive && 'font-medium',
                          sourceMissing
                            ? 'text-(--color-text-muted)'
                            : sourceIsActive ? 'text-(--color-text)' : 'text-(--color-text-2) group-hover:text-(--color-text)',
                        )}
                      >
                        {sourceLabel}
                      </span>
                      {sourceMissing && <MissingBadge />}
                      <WorkspaceGroupDots groups={sourceGroups} />
                      {mobileLongPressActions && (sourceWaitingCount > 0 || sourceHasRunningSession) && (
                        <span data-workspace-status="" className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-meta tabular-nums text-(--color-text-muted)">
                          <SessionStatusMark
                            status={sourceWaitingCount > 0 ? 'needs_input' : 'running'}
                            label={sourceWaitingCount > 0 ? `${sourceWaitingCount} waiting for you` : `${sourceRunningSessions.length} running`}
                          />
                          <span aria-hidden="true">{sourceWaitingCount > 0 ? sourceWaitingCount : sourceRunningSessions.length}</span>
                        </span>
                      )}
                      {sourceIsPending && (
                        <span>
                          <Loader2 size={12} className="shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />
                        </span>
                      )}
                    </LongPressButton>
                  }
                />
                <TooltipContent>
                  {sourceIsChat ? 'Chat workspace' : sourceMissing ? `Folder not found at ${path}` : path}
                  {sourceGroups.length > 0 && <span className="block">{workspaceGroupsLabel(sourceGroups)}</span>}
                </TooltipContent>
              </Tooltip>
              {worktrees.length > 0 && (
                // Always visible and always compact (branch icon + worktree
                // count, the pill every row count uses), so the repository
                // name keeps the row; a filter shows as the chip's fill and
                // as a row atop the list.
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <CountChip
                        icon={GitBranch}
                        count={worktrees.length}
                        active={Boolean(checkouts.selected)}
                        mark={worktreeIsRemoving ? <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden="true" /> : undefined}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect()
                          setCheckoutMenu({ repo: path, x: rect.left, y: rect.bottom + 4 })
                        }}
                        aria-haspopup="menu"
                        aria-expanded={checkoutMenuRepo === path}
                        aria-label={checkoutCountLabel(worktrees)}
                        aria-description={`${sourceLabel}: ${worktreeChipHint}`}
                      />
                    }
                  />
                  <TooltipContent>{worktreeChipHint}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => newSessionIn(sessionTarget)}
                      // Like session rows, the actions take no room at rest,
                      // so the folder name keeps the whole row.
                      className={`ml-1 ${ROW_ACTION} ${mobileLongPressActions ? 'hidden' : rowActionsReveal('')}`}
                      aria-label={selectedWorktree ? `New session in worktree ${selectedWorktree.name}` : `New session in ${sourceLabel}`}
                    >
                      <Plus size={12} aria-hidden="true" />
                    </button>
                  }
                />
                <TooltipContent>{selectedWorktree ? `New session in ${selectedWorktree.name}` : 'New session'}</TooltipContent>
              </Tooltip>
              {sourceIsChat ? (
                // Chat has no actions menu; hold its slot so the + lines up
                // with every other workspace row.
                !mobileLongPressActions && <span aria-hidden="true" className={`mr-1 w-6 shrink-0 pointer-coarse:w-9 ${rowActionsReveal('')}`} />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={(event) => {
                          if (isMobile) {
                            setMobileWorkspaceActions({ path, sessionPath: sessionTarget, kind: 'main' })
                            return
                          }
                          const rect = event.currentTarget.getBoundingClientRect()
                          setDesktopWorkspaceActions({ path, sessionPath: sessionTarget, x: rect.left, y: rect.bottom + 4 })
                        }}
                        className={`mr-1 ${ROW_ACTION} ${mobileLongPressActions ? 'hidden' : rowActionsReveal('')}`}
                        aria-haspopup="menu"
                        aria-label={`Actions for ${sourceLabel}`}
                      >
                        <MoreHorizontal size={12} aria-hidden="true" />
                      </button>
                    }
                  />
                  <TooltipContent>Workspace actions</TooltipContent>
                </Tooltip>
              )}
            </div>

            <Collapsible open={sourceIsExpanded || sourceHasRunningSession}>
              {/* One level: every checkout's sessions hang off a single
                  guide under the chevron (the tree's one indent, which a
                  session's subagent rows use too), status marks under the
                  folder. Expanding and collapsing fold the rows (height motion). */}
              <div className="mr-1.5 border-l border-(--color-border-subtle) pb-1 pl-1" style={{ marginLeft: TREE_INDENT_PX }}>
                {checkouts.selected && sourceIsExpanded && (
                  // The active filter, named where its sessions are, with
                  // a one-step way back to every checkout.
                  <div className="flex h-6 items-center gap-1.5 px-1.5 text-meta text-(--color-text-subtle) pointer-coarse:h-9">
                    <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
                      {selectedWorktree && selectedWorktree.kind !== 'folder'
                        ? <GitBranch size={12} className="text-(--accent-orange-text)" />
                        : <Folder size={12} className="text-(--color-accent)" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-(--color-text-2)">
                      {selectedWorktree?.name ?? 'Workspace'}
                    </span>
                    <button
                      type="button"
                      onClick={() => selectCheckout(path, null)}
                      className={ROW_TEXT_ACTION}
                      aria-label={`Show all worktrees in ${sourceLabel}`}
                    >
                      Show all
                    </button>
                  </div>
                )}
                <WorkspaceSessionList
                  path={checkouts.listPaths[0]}
                  paths={checkouts.listPaths}
                  // Tags only help while several checkouts share the list.
                  checkoutNames={checkouts.selected ? undefined : checkouts.worktreeNames}
                  currentSessionId={currentSessionId}
                  runningSessions={sourceRunningSessions}
                  collapsed={!sourceIsExpanded}
                  showDetails={showDetails}
                  draftActive={draftWorkspace !== null && checkouts.listPaths.includes(draftWorkspace)}
                  mobileLongPressActions={mobileLongPressActions}
                  editingSessionId={editingSessionId}
                  {...sessionRowHandlers}
                />
              </div>
            </Collapsible>
          </div>
        )
      })}

      {workspaceTreePending && (
        // First load: placeholder rows, not "No workspaces yet".
        <div role="status" aria-label="Loading workspaces" className="space-y-2 px-3 py-2" data-sidebar-tree-loading="">
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}
    </div>
  )
}
