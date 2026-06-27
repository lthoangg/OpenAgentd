/**
 * SchedulerPanel — modal overlay for managing scheduled tasks.
 *
 * Mirrors MemoryPanel structure: fixed overlay with right-sliding drawer,
 * backdrop click to close, and X close button.
 */

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Clock, Plus, Loader2, AlertCircle, CalendarClock, ArrowLeft } from 'lucide-react'
import { SearchBar } from '@/components/ui/search-bar'
import {
  useScheduledTasksQuery,
} from '@/queries'
import type { ScheduledTaskMode } from '@/api/types'
import { useIsMobile } from '@/hooks/use-mobile'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
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
  const prefersReducedMotion = useReducedMotion()
  useModalFocus(open, onClose)

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
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-x-0 bottom-0 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))] z-40 bg-black/40 sm:inset-0"
          />

          <motion.aside
            key="dialog"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="fixed inset-x-0 bottom-0 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))] z-50 flex flex-col overflow-hidden border-(--color-border) bg-(--bg-page) shadow-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(90vh,860px)] sm:w-[min(90vw,1180px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-md sm:border"
            role="dialog"
            aria-modal="true"
            aria-label="Scheduled tasks"
            data-modal-focus="true"
          >
            {/* Header */}
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-3 sm:px-5 sm:py-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {/* Mobile back button — shown in detail/create pane */}
                {isMobile && mobilePane !== 'list' && (
                  <button
                    onClick={handleBackToList}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
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
                    className="flex h-8 w-8 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                    aria-label="Create new task"
                    title="Create task"
                  >
                    <Plus size={16} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
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
                  <div className="flex-1 overflow-y-auto">
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
                      contextMode={contextMode}
                      contextWorkspace={contextWorkspace}
                      onSuccess={handleCloseDetail}
                    />
                  )}
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

// ── Task list item ──────────────────────────────────────────────────────────


export { ModeWorkspaceFields } from './SchedulerPanel/ModeWorkspaceFields'
