import { useEffect, useState } from 'react'
import { useDebouncedCallback } from '@tanstack/react-pacer'
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

export function SchedulerPanel({
  open,
  onClose,
  contextMode = 'normal',
  contextWorkspace = null,
}: SchedulerPanelProps) {
  const isMobile = useIsMobile()

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const updateDebouncedSearchQuery = useDebouncedCallback(setDebouncedSearchQuery, {
    wait: 150,
    key: 'scheduler-task-search',
  })
  const [mobilePane, setMobilePane] = useState<'list' | 'detail' | 'create'>('list')

  const tasksQuery = useScheduledTasksQuery()

  useEffect(() => {
    if (open) {
      tasksQuery.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const tasks = tasksQuery.data?.tasks ?? []

  const filteredTasks = tasks.filter((task) => {
    const q = debouncedSearchQuery.toLowerCase()
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

  const handleTaskDeleted = (id: string) => {
    if (selectedTaskId === id) handleCloseDetail()
  }

  const handleOpenCreate = () => {
    setSelectedTaskId(null)
    if (isMobile) setMobilePane('create')
  }

  const handleBackToList = () => {
    setMobilePane('list')
  }

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
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Mobile back button */}
          {isMobile && mobilePane !== 'list' && (
            <button
              onClick={handleBackToList}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
              aria-label="Back to task list"
            >
              <ArrowLeft size={14} />
            </button>
          )}
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-(--color-accent)/30 bg-(--color-accent)/10 text-(--color-accent)">
              <CalendarClock size={15} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-bold text-(--color-text)">
                  {isMobile && mobilePane === 'create'
                    ? 'Create Task'
                    : isMobile && mobilePane === 'detail'
                      ? (selectedTask?.name ?? 'Task')
                      : 'Scheduled Tasks'}
                </h2>
                {tasks.length > 0 && (!isMobile || mobilePane === 'list') && (
                  <span className="rounded-full bg-(--bg-key) px-1.5 py-0.2 font-mono text-[10px] font-semibold text-(--color-text-subtle)">
                    {tasks.length}
                  </span>
                )}
              </div>
              {(!isMobile || mobilePane === 'list') && (
                <p
                  className="truncate text-[11px] text-(--color-text-muted)"
                  title="Normal and coding scheduled tasks"
                >
                  All scheduled tasks
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Desktop/Mobile: Create button */}
          {selectedTaskId !== null && !isMobile && (
            <button
              onClick={handleOpenCreate}
              className="flex h-7 items-center gap-1 rounded-sm border border-(--color-border) bg-(--bg-card) px-2 text-xs font-medium text-(--color-text) transition-colors hover:bg-(--bg-key) hover:border-(--color-border-strong)"
              title="Create new task"
            >
              <Plus size={12} />
              <span>New Task</span>
            </button>
          )}
          {isMobile && mobilePane === 'list' && (
            <button
              onClick={handleOpenCreate}
              className="flex h-7 w-7 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text) transition-colors hover:bg-(--bg-key)"
              aria-label="Create new task"
              title="Create task"
            >
              <Plus size={13} />
            </button>
          )}
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
            aria-label="Close scheduler panel"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* List panel */}
        {showList && (
          <div className={`flex flex-col bg-(--bg-sidebar) ${isMobile ? 'w-full' : 'w-96 shrink-0 border-r border-(--color-border)'}`}>
            {/* Search bar */}
            <div className="border-b border-(--color-border) bg-(--bg-sidebar) p-2.5">
              <SearchBar
                placeholder="Search tasks…"
                value={searchQuery}
                onChange={(event) => {
                  const nextQuery = event.target.value
                  setSearchQuery(nextQuery)
                  updateDebouncedSearchQuery(nextQuery)
                }}
              />
            </div>

            {/* Task list */}
            <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y">
              {tasksQuery.isLoading ? (
                <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
                  <Loader2 size={22} className="animate-spin text-(--color-accent)" />
                  <p className="text-xs text-(--color-text-muted)">Loading scheduled tasks…</p>
                </div>
              ) : tasksQuery.isError ? (
                <div className="flex flex-col items-center justify-center gap-2.5 p-8 text-center">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-(--color-error-subtle) text-(--color-error)">
                    <AlertCircle size={18} />
                  </div>
                  <p className="text-sm font-medium text-(--color-error)">Failed to load tasks</p>
                </div>
              ) : filteredTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card) text-(--color-text-muted)">
                    <Clock size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-(--color-text)">
                      {searchQuery ? 'No tasks match your search' : 'No scheduled tasks yet'}
                    </p>
                    {!searchQuery && !isMobile && (
                      <p className="mt-1 text-xs text-(--color-text-subtle)">
                        Use the form on the right to create one.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5 p-2">
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

export { ModeWorkspaceFields } from './SchedulerPanel/ModeWorkspaceFields'
