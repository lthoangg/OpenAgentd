import { useState } from 'react'
import { CommandPalette, QuickOpen } from '../CommandPalette'
import { lazySurface } from '@/lib/lazy-surface'
import { TodosPopover } from '../TodosPopover'
import type { SessionGoal, SessionPlan, TodoItem, WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'

// Kept out of the startup bundle; prefetched while the app is idle.
const SchedulerPanel = lazySurface(() => import('../SchedulerPanel'), 'SchedulerPanel')

/** True from the first time ``open`` is set, so a panel mounted then can still animate out. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return opened
}

interface AgentChatPanelsProps {
  /** Popover fallback: mobile, or desktop without a review dock. */
  showTodos: boolean
  onShowTodosChange: (open: boolean) => void
  todos: TodoItem[]
  /** The session's goal; it heads the task popover. */
  goal?: SessionGoal | null
  plan?: SessionPlan | null
  onClearPlan?: () => void
  /** Open the plan in the dock's Plan tab; unset without a workspace. */
  onOpenPlan?: () => void
  /** Open the goal in the dock's Goal tab; unset without a workspace. */
  onOpenGoal?: () => void
  /** Pause and Resume from the task popover's goal row. */
  onGoalAction?: (action: 'pause' | 'resume') => void
  schedulerOpen: boolean
  onCloseScheduler: () => void
  showPalette: boolean
  /** Pages the palette opens on (see ``useUIStore.openPaletteAt``). */
  palettePage: string[]
  /** Remounts the palette when it is sent to another page while open. */
  paletteKey: number
  paletteCommands: Command[]
  quickOpenOpen: boolean
  /** Query Quick Open opens with; empty from its shortcut. */
  quickOpenQuery: string
  quickOpenWorkspaceFiles: WorkspaceFileInfo[]
  /** Backend hit its file cap — Quick Open says so instead of silently hiding. */
  quickOpenFilesTruncated?: boolean
  onQuickOpenFileOpen: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
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
  quickOpenOpen,
  quickOpenQuery,
  quickOpenWorkspaceFiles,
  quickOpenFilesTruncated,
  onQuickOpenFileOpen,
  onClosePalette,
  onCloseQuickOpen,
}: AgentChatPanelsProps) {
  const schedulerOpened = useOpenedOnce(schedulerOpen)
  return (
    <>
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
      {schedulerOpened && (
        <SchedulerPanel
          open={schedulerOpen}
          onClose={onCloseScheduler}
        />
      )}
      {showPalette && (
        <CommandPalette key={paletteKey} commands={paletteCommands} onClose={onClosePalette} initialPagePath={palettePage} />
      )}
      {quickOpenOpen && (
        <QuickOpen workspaceFiles={quickOpenWorkspaceFiles} filesTruncated={quickOpenFilesTruncated} commands={paletteCommands} onFileOpen={onQuickOpenFileOpen} onClose={onCloseQuickOpen} initialQuery={quickOpenQuery} />
      )}
    </>
  )
}
