/**
 * SchedulerDockView — scheduled tasks as a review-dock tab (desktop, and
 * phones with a workspace, where the dock is a sheet).
 *
 * The dock is too narrow for the overlay's list + detail split, so panes
 * stack: list → detail or create, with a back arrow in each pane header.
 * Lists tasks from every workspace; new tasks default to the chat's
 * workspace.
 */
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useScheduledTasksQuery } from '@/queries'
import { useUIStore } from '@/stores/useUIStore'
import { CreateTaskForm } from './CreateTaskForm'
import { TaskDetailView } from './TaskDetailView'
import { TaskListPane } from './TaskListPane'
import { SchedulerChromeContext } from './chrome'
import { useSchedulerDraftGuard } from './draftGuard'

type Pane = 'list' | 'detail' | 'create'

export function SchedulerDockView({ contextWorkspace }: { contextWorkspace: string | null }) {
  const [pane, setPane] = useState<Pane>('list')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const tasksQuery = useScheduledTasksQuery()
  const { refetch } = tasksQuery
  const focusTaskId = useUIStore((s) => s.scheduledTaskFocus)
  const { guard, provide } = useSchedulerDraftGuard()

  // Same freshness rule as the overlay: opening the view re-reads the list.
  useEffect(() => {
    void refetch()
  }, [refetch])

  useEffect(() => {
    if (!focusTaskId) return
    setSelectedTaskId(focusTaskId)
    setPane('detail')
    useUIStore.getState().focusScheduledTask(null)
  }, [focusTaskId])

  const tasks = tasksQuery.data?.tasks ?? []
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) ?? null : null

  const backToList = () => {
    setSelectedTaskId(null)
    setPane('list')
  }
  const guardedBackToList = () => guard(backToList)

  return (
    <SchedulerChromeContext.Provider value="dock">
      {provide(
      <div className="@container flex h-full min-h-0 flex-col">
        {pane === 'detail' && selectedTask ? (
          <TaskDetailView task={selectedTask} onClose={guardedBackToList} closeMode="back" />
        ) : pane === 'create' ? (
          <CreateTaskForm
            key={`create-${contextWorkspace ?? ''}`}
            contextWorkspace={contextWorkspace}
            onSuccess={backToList}
            onBack={guardedBackToList}
          />
        ) : (
          <>
            <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) pr-1 pl-3">
              <span className="min-w-0 flex-1 truncate text-xs text-(--color-text-muted)">All workspaces</span>
              {tasks.length > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-(--color-text-subtle)">
                  {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setSelectedTaskId(null)
                  setPane('create')
                }}
                className="flex h-6 shrink-0 items-center gap-1 rounded-sm border border-(--color-border) px-2 text-xs font-medium text-(--color-text) transition-colors hover:border-(--color-border-strong) hover:bg-(--bg-key)"
              >
                <Plus size={12} aria-hidden="true" />
                New task
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <TaskListPane
                tasks={tasks}
                isLoading={tasksQuery.isLoading}
                isError={tasksQuery.isError}
                selectedTaskId={selectedTaskId}
                onSelect={(id) => {
                  setSelectedTaskId(id)
                  setPane('detail')
                }}
                onDeleted={(id) => {
                  if (selectedTaskId === id) backToList()
                }}
                emptyHint="Use New task to create one."
                searchKey="scheduler-dock-task-search"
              />
            </div>
          </>
        )}
      </div>,
      )}
    </SchedulerChromeContext.Provider>
  )
}
