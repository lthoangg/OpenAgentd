import { useState } from 'react'
import { lazySurface } from '@/lib/lazy-surface'
import type { SessionGoal, SessionPlan, TodoItem, WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'

// Kept out of the startup bundle; prefetched while the app is idle.
const SchedulerPanel = lazySurface(() => import('../SchedulerPanel'), 'SchedulerPanel')
const PaletteHost = lazySurface(() => import('./PaletteHost'), 'PaletteHost')
const TodosPopover = lazySurface(() => import('../TodosPopover'), 'TodosPopover')

/** True from the first time ``open`` is set, so a panel mounted then can still animate out. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return opened
}

interface AgentChatPanelsProps {
  /**
   * The task list where the review dock's Tasks tab is not it: a popover under
   * the header on mobile and on desktop without a dock, and on a phone a
   * bottom sheet with two detents (``TodosPopover`` picks the form).
   */
  showTodos: boolean
  onShowTodosChange: (open: boolean) => void
  todos: TodoItem[]
  /** The session's goal; it heads the task list. */
  goal?: SessionGoal | null
  plan?: SessionPlan | null
  onClearPlan?: () => void
  /** Open the plan in the dock's Plan tab; unset without a workspace. */
  onOpenPlan?: () => void
  /** Open the goal in the dock's Goal tab; unset without a workspace. */
  onOpenGoal?: () => void
  /** Pause and Resume from the task list's goal row. */
  onGoalAction?: (action: 'pause' | 'resume') => void
  schedulerOpen: boolean
  onCloseScheduler: () => void
  showPalette: boolean
  /** Pages the palette opens on (see ``useUIStore.openPaletteAt``). */
  palettePage: string[]
  /** Remounts the palette when it is sent to another page while open. */
  paletteKey: number
  paletteCommands: Command[]
  /** The open session; the palette's Sessions group leaves it out. */
  sessionId?: string | null
  /** The palette scoped to files (⌘P, "Find file"). */
  quickOpenOpen: boolean
  /** Query the file scope opens with; empty from its shortcut. */
  quickOpenQuery: string
  quickOpenWorkspaceFiles: WorkspaceFileInfo[]
  /** Backend hit its file cap — the palette says so instead of silently hiding. */
  quickOpenFilesTruncated?: boolean
  /** The file listing has not arrived yet. */
  quickOpenFilesLoading?: boolean
  /** Unset without a workspace: the palette then has no files to offer. */
  onQuickOpenFileOpen?: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
  onClosePalette: () => void
  onCloseQuickOpen: () => void
}

export function AgentChatPanels({
  showTodos,
  onShowTodosChange,
  todos,
  goal = null,
  plan,
  onClearPlan,
  onOpenPlan,
  onOpenGoal,
  onGoalAction,
  schedulerOpen,
  onCloseScheduler,
  showPalette,
  palettePage,
  paletteKey,
  paletteCommands,
  sessionId = null,
  quickOpenOpen,
  quickOpenQuery,
  quickOpenWorkspaceFiles,
  quickOpenFilesTruncated,
  quickOpenFilesLoading,
  onQuickOpenFileOpen,
  onClosePalette,
  onCloseQuickOpen,
}: AgentChatPanelsProps) {
  const schedulerOpened = useOpenedOnce(schedulerOpen)
  const todosOpened = useOpenedOnce(showTodos)
  // ⌘K and ⌘P open the same overlay; only its scope differs.
  const files = {
    workspaceFiles: quickOpenWorkspaceFiles,
    filesTruncated: quickOpenFilesTruncated,
    filesLoading: quickOpenFilesLoading,
    onFileOpen: onQuickOpenFileOpen,
  }
  return (
    <>
      {todosOpened && (
      <TodosPopover
        open={showTodos}
        onOpenChange={onShowTodosChange}
        todos={todos}
        goal={goal}
        plan={plan}
        onClearPlan={onClearPlan}
        onOpenPlan={onOpenPlan}
        onOpenGoal={onOpenGoal}
        onGoalAction={onGoalAction}
      />
      )}
      {schedulerOpened && (
        <SchedulerPanel
          open={schedulerOpen}
          onClose={onCloseScheduler}
        />
      )}
      {showPalette && (
        <PaletteHost key={paletteKey} sessionId={sessionId} commands={paletteCommands} onClose={onClosePalette} initialPagePath={palettePage} {...files} />
      )}
      {quickOpenOpen && (
        <PaletteHost scope="files" sessionId={sessionId} commands={paletteCommands} onClose={onCloseQuickOpen} initialQuery={quickOpenQuery} {...files} />
      )}
    </>
  )
}
