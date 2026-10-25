import { useEffect, useState } from 'react'
import { Plus, CalendarClock, ArrowLeft } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useScheduledTasksQuery,
} from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/stores/useUIStore'
import { AppOverlay, OverlayHeader } from '@/components/ui/app-overlay'
import { Button } from '@/components/ui/button'
import { CreateTaskForm } from './SchedulerPanel/CreateTaskForm'
import { TaskDetailView } from './SchedulerPanel/TaskDetailView'
import { TaskListPane } from './SchedulerPanel/TaskListPane'
import { useSchedulerDraftGuard } from './SchedulerPanel/draftGuard'

interface SchedulerPanelProps {
  open: boolean
  onClose: () => void
  /** Workspace inherited from the surrounding chat view. */
  contextWorkspace?: string | null
}

export function SchedulerPanel({
  open,
  onClose,
  contextWorkspace = null,
}: SchedulerPanelProps) {
  const isMobile = useIsMobile()
  // Everything below that would unmount a Create/Edit form goes through
  // `guard`; a successful submit (`onSuccess`) does not.
  const { guard, provide } = useSchedulerDraftGuard()
  const close = () => guard(onClose)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [mobilePane, setMobilePane] = useState<'list' | 'detail' | 'create'>('list')

  const tasksQuery = useScheduledTasksQuery()
  const { refetch: refetchTasks } = tasksQuery

  useEffect(() => {
    if (open) {
      refetchTasks()
    }
  }, [open, refetchTasks])

  const tasks = tasksQuery.data?.tasks ?? []

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null

  const focusTaskId = useUIStore((s) => s.scheduledTaskFocus)
  useEffect(() => {
    if (!open || !focusTaskId) return
    setSelectedTaskId(focusTaskId)
    if (isMobile) setMobilePane('detail')
    useUIStore.getState().focusScheduledTask(null)
  }, [focusTaskId, isMobile, open])

  const handleSelectTask = (id: string) => guard(() => {
    setSelectedTaskId(id)
    if (isMobile) setMobilePane('detail')
  })

  const handleCloseDetail = () => {
    setSelectedTaskId(null)
    if (isMobile) setMobilePane('list')
  }

  const handleTaskDeleted = (id: string) => {
    if (selectedTaskId === id) handleCloseDetail()
  }

  const handleOpenCreate = () => guard(() => {
    setSelectedTaskId(null)
    if (isMobile) setMobilePane('create')
  })

  const handleBackToList = () => guard(() => {
    setMobilePane('list')
  })

  const showList = !isMobile || mobilePane === 'list'
  const showDetail = !isMobile || mobilePane === 'detail' || mobilePane === 'create'

  return (
    <AppOverlay
      open={open}
      onClose={close}
      label="Scheduled tasks"
      maxWidth="1100px"
    >
      {provide(<>
      <OverlayHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {isMobile && mobilePane === 'create'
                ? 'Create task'
                : isMobile && mobilePane === 'detail'
                  ? (selectedTask?.name ?? 'Task')
                  : 'Scheduled tasks'}
            </span>
            {tasks.length > 0 && (!isMobile || mobilePane === 'list') && (
              <span className="shrink-0 rounded-full bg-(--bg-key) px-1.5 py-0.5 font-mono text-[11px] font-normal text-(--color-text-subtle)">
                {tasks.length}
              </span>
            )}
          </span>
        }
        icon={<CalendarClock size={14} />}
        subtitle={!isMobile || mobilePane === 'list' ? 'All scheduled tasks' : undefined}
        onClose={close}
        closeLabel="Close scheduler panel"
        leading={
          isMobile && mobilePane !== 'list' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" className="md:size-7" onClick={handleBackToList} aria-label="Back to task list">
                    <ArrowLeft size={14} />
                  </Button>
                }
              />
              <TooltipContent>Back to task list</TooltipContent>
            </Tooltip>
          )
        }
        actions={
          <>
            {selectedTaskId !== null && !isMobile && (
              <Button size="sm" className="md:h-7" onClick={handleOpenCreate}>
                <Plus size={12} aria-hidden="true" />
                New task
              </Button>
            )}
            {isMobile && mobilePane === 'list' && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="icon-sm" className="md:size-7" onClick={handleOpenCreate} aria-label="Create new task">
                      <Plus size={13} />
                    </Button>
                  }
                />
                <TooltipContent>Create task</TooltipContent>
              </Tooltip>
            )}
          </>
        }
      />

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* List panel */}
        {showList && (
          <div className={`flex flex-col bg-(--bg-sidebar) ${isMobile ? 'w-full' : 'w-96 shrink-0 border-r border-(--color-border)'}`}>
            <TaskListPane
              tasks={tasks}
              isLoading={tasksQuery.isLoading}
              isError={tasksQuery.isError}
              onRetry={() => void refetchTasks()}
              selectedTaskId={selectedTaskId}
              onSelect={handleSelectTask}
              onDeleted={handleTaskDeleted}
              emptyHint={isMobile ? undefined : 'Use the form on the right to create one.'}
            />
          </div>
        )}

        {/* Detail / Create panel */}
        {showDetail && (
          // Container, not viewport, breakpoints: the same forms render in
          // the review dock's Schedule tab at a fraction of the window.
          <div className="@container flex flex-1 flex-col overflow-hidden">
            {selectedTask && (!isMobile || mobilePane === 'detail') ? (
              <TaskDetailView
                task={selectedTask}
                onClose={() => guard(handleCloseDetail)}
                hostTitled={isMobile}
              />
            ) : (
              <CreateTaskForm
                key={`create-${contextWorkspace ?? ''}`}
                contextWorkspace={contextWorkspace}
                onSuccess={handleCloseDetail}
                hostTitled={isMobile}
              />
            )}
          </div>
        )}
      </div>
      </>)}
    </AppOverlay>
  )
}

export { ModeWorkspaceFields } from './SchedulerPanel/ModeWorkspaceFields'
