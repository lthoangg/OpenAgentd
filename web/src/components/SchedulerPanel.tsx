/**
 * SchedulerPanel — modal overlay for managing scheduled tasks.
 *
 * Mirrors MemoryPanel structure: fixed overlay with right-sliding drawer,
 * backdrop click to close, and X close button.
 */

import { useEffect, useState } from 'react'
import { X, Clock, Plus, Loader2, AlertCircle, CalendarClock, ArrowLeft } from 'lucide-react'
import { SearchBar } from '@/components/ui/search-bar'
import {
  useScheduledTasksQuery,
} from '@/queries'
import type { ScheduledTaskMode } from '@/api/types'
import { useIsMobile } from '@/hooks/use-mobile'
import { AppOverlay } from '@/components/ui/app-overlay'
import { TaskListItem } from './SchedulerPanel/TaskListItem'
import { CreateTaskForm } from './SchedulerPanel/CreateTaskForm'
import { TaskDetailView } from './SchedulerPanel/TaskDetailView'

interface SchedulerPanelProps {
  open: boolean
  onClose: () => void
  /** Routing target inherited from the surrounding chat view. When the
   *  scheduler is opened inside a coding workspace, the Create form
   *  pre-fills mode='coding' + that workspace. Edit forms always start
   *  from the task's own stored mode/workspace. */
  contextMode?: ScheduledTaskMode
  contextWorkspace?: string | null
}

// ── Shared utility ──────────────────────────────────────────────────────────

// Form fields sit on a bg-(--bg-card) panel; the shared <Input>/<Textarea>/
// <SelectTrigger> primitives default to bg-transparent which leaves them
// indistinguishable from the parent. Give them an explicit fillable surface
// so the controls read as inputs.
export function SchedulerPanel({
  open,
  onClose,
  contextMode = 'normal',
  contextWorkspace = null,
}: SchedulerPanelProps) {
  const isMobile = useIsMobile()

  // Ephemeral panel-scoped state — not shared outside this component tree,
  // so useState is correct here (no need for Zustand).
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Mobile: 'list' | 'detail' | 'create'
  const [mobilePane, setMobilePane] = useState<'list' | 'detail' | 'create'>('list')

  const tasksQuery = useScheduledTasksQuery()

  // Refresh on open — the drawer is mounted persistently so AnimatePresence
  // can play exit animations; without this the list goes stale on reopen.
  useEffect(() => {
    if (open) {
      tasksQuery.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const tasks = tasksQuery.data?.tasks ?? []

  // Show all scheduled tasks. Each row carries a routing badge so users can
  // distinguish normal reminders from coding-workspace reminders.
  const filteredTasks = tasks.filter((task) => {
    const q = searchQuery.toLowerCase()
    if (!q) return true
    return (
      task.name.toLowerCase().includes(q) ||
      task.mode.toLowerCase().includes(q) ||
      (task.workspace ?? '').toLowerCase().includes(q)
    )
  })

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id)
    if (isMobile) setMobilePane('detail')
  }

  const handleCloseDetail = () => {
    setSelectedTaskId(null)
    if (isMobile) setMobilePane('list')
  }

  // When a task is deleted from the list, drop the selection if it was the
  // currently-selected one — otherwise the detail pane (mobile especially)
  // would render an empty state until the user navigates back manually.
  const handleTaskDeleted = (id: string) => {
    if (selectedTaskId === id) handleCloseDetail()
  }

  const handleOpenCreate = () => {
    if (isMobile) setMobilePane('create')
  }

  const handleBackToList = () => {
    setMobilePane('list')
  }

  // On mobile: show list OR detail/create — never both side-by-side.
  const showList = !isMobile || mobilePane === 'list'
  const showDetail = !isMobile || mobilePane === 'detail' || mobilePane === 'create'

  return (
    <AppOverlay
      open={open}
      onClose={onClose}
      label="Scheduled tasks"
      maxWidth="1100px"
    >
            {/* Header */}
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-3 sm:px-5 sm:py-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {/* Mobile back button — shown in detail/create pane */}
                {isMobile && mobilePane !== 'list' && (
                  <button
                    onClick={handleBackToList}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                    aria-label="Back to task list"
                  >
                    <ArrowLeft size={14} />
                  </button>
                )}
                <div className="flex min-w-0 items-center gap-2">
                  <CalendarClock size={18} className="shrink-0 text-(--color-accent)" />
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-(--color-text)">
                      {isMobile && mobilePane === 'create'
                        ? 'Create Task'
                        : isMobile && mobilePane === 'detail'
                          ? (selectedTask?.name ?? 'Task')
                          : 'Scheduled Tasks'}
                    </h2>
                    {(!isMobile || mobilePane === 'list') && (
                      <p
                        className="mt-0.5 truncate text-xs text-(--color-text-muted)"
                        // ``title`` exposes the full workspace path on
                        // hover when the truncated label hides it.
                        title="Normal and coding scheduled tasks"
                      >
                        All scheduled tasks
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Mobile: Create button shown in list pane */}
                {isMobile && mobilePane === 'list' && (
                  <button
                    onClick={handleOpenCreate}
                    className="flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                    aria-label="Create new task"
                    title="Create task"
                  >
                    <Plus size={16} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                  aria-label="Close scheduler panel"
                  title="Close (Esc)"
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            {/* Main content */}
            <div className="flex flex-1 overflow-hidden">
              {/* List panel */}
              {showList && (
                <div className={`flex flex-col bg-(--bg-sidebar) ${isMobile ? 'w-full' : 'w-96 shrink-0 border-r border-(--color-border)'}`}>
                  {/* Search bar */}
                  <div className="border-b border-(--color-border) bg-(--bg-sidebar) p-3">
                    <SearchBar
                      placeholder="Search tasks…"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

                  {/* Task list */}
                  <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y">
                    {tasksQuery.isLoading ? (
                      <div className="flex items-center justify-center p-8">
                        <Loader2 size={20} className="animate-spin text-(--color-text-muted)" />
                      </div>
                    ) : tasksQuery.isError ? (
                      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
                        <AlertCircle size={20} className="text-(--color-error)" />
                        <p className="text-sm text-(--color-text-muted)">Failed to load tasks</p>
                      </div>
                    ) : filteredTasks.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
                        <Clock size={20} className="text-(--color-text-muted)" />
                        <p className="text-sm text-(--color-text-muted)">
                          {searchQuery ? 'No tasks match your search' : 'No scheduled tasks yet'}
                        </p>
                        {!searchQuery && !isMobile && (
                          <p className="text-xs text-(--color-text-subtle)">
                            Use the form on the right to create one.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1.5 p-2.5">
                        {filteredTasks.map((task) => (
                          <TaskListItem
                            key={task.id}
                            task={task}
                            isSelected={selectedTaskId === task.id}
                            onSelect={() => handleSelectTask(task.id)}
                            onDeleted={() => handleTaskDeleted(task.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Detail / Create panel */}
              {showDetail && (
                <div className="flex flex-1 flex-col overflow-hidden">
                  {selectedTask && (!isMobile || mobilePane === 'detail') ? (
                    <TaskDetailView
                      task={selectedTask}
                      onClose={handleCloseDetail}
                    />
                  ) : (
                    <CreateTaskForm
                      key={`create-${contextMode}-${contextWorkspace ?? ''}`}
                      contextMode={contextMode}
                      contextWorkspace={contextWorkspace}
                      onSuccess={handleCloseDetail}
                    />
                  )}
                </div>
              )}
            </div>
    </AppOverlay>
  )
}

// ── Task list item ──────────────────────────────────────────────────────────


export { ModeWorkspaceFields } from './SchedulerPanel/ModeWorkspaceFields'
