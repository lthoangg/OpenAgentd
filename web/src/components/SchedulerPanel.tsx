import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useScheduledTasksQuery,
} from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { useIsPhone } from '@/hooks/use-is-phone'
import { NEW_SCHEDULED_TASK, useUIStore } from '@/stores/useUIStore'
import { AppOverlay, OVERLAY_MAX_WIDTH, OverlayHeader } from '@/components/ui/app-overlay'
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
  // Desktop shows a task, not an empty form: the first one until the user
  // picks another or asks for "New task".
  const [creating, setCreating] = useState(false)
  // The detail / create pane, so an empty list's "New task" can reach its form.
  const detailRef = useRef<HTMLDivElement>(null)

  const tasksQuery = useScheduledTasksQuery()
  const { refetch: refetchTasks } = tasksQuery

  useEffect(() => {
    if (open) {
      refetchTasks()
    }
  }, [open, refetchTasks])

  const tasks = tasksQuery.data?.tasks ?? []

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null

  // Desktop opens on the first task's detail rather than an empty form.
  const firstTaskId = tasks[0]?.id ?? null
  useEffect(() => {
    if (!open || isMobile || creating || selectedTask || firstTaskId === null) return
    setSelectedTaskId(firstTaskId)
  }, [open, isMobile, creating, selectedTask, firstTaskId])

  const focusTaskId = useUIStore((s) => s.scheduledTaskFocus)
  useEffect(() => {
    if (!open || !focusTaskId) return
    if (focusTaskId === NEW_SCHEDULED_TASK) {
      setCreating(true)
      setSelectedTaskId(null)
      if (isMobile) setMobilePane('create')
    } else {
      setSelectedTaskId(focusTaskId)
      if (isMobile) setMobilePane('detail')
    }
    useUIStore.getState().focusScheduledTask(null)
  }, [focusTaskId, isMobile, open])

  const handleSelectTask = (id: string) => guard(() => {
    setCreating(false)
    setSelectedTaskId(id)
    if (isMobile) setMobilePane('detail')
  })

  const handleCloseDetail = () => {
    setSelectedTaskId(null)
    setCreating(true)
    if (isMobile) setMobilePane('list')
  }

  const handleTaskDeleted = (id: string) => {
    if (selectedTaskId === id) handleCloseDetail()
  }

  const handleOpenCreate = () => guard(() => {
    setCreating(true)
    setSelectedTaskId(null)
    if (isMobile) setMobilePane('create')
  })

  const handleBackToList = () => guard(() => {
    setMobilePane('list')
  })

  const showList = !isMobile || mobilePane === 'list'
  // A phone's list carries a large title, as Sessions and Settings do (mockup J9).
  const largeTitle = useIsPhone() && mobilePane === 'list'
  const showDetail = !isMobile || mobilePane === 'detail' || mobilePane === 'create'

  return (
    <AppOverlay
      open={open}
      onClose={close}
      // A phone's Back (Escape here) leaves a task for the list before it
      // closes the sheet, as the ‹ does.
      onEscape={isMobile && mobilePane !== 'list' ? () => guard(handleBackToList) : undefined}
      label="Scheduled tasks"
      maxWidth={OVERLAY_MAX_WIDTH.split}
    >
      {provide(<>
      <OverlayHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {isMobile && mobilePane === 'create'
                ? 'New task'
                : isMobile && mobilePane === 'detail'
                  ? (selectedTask?.name ?? 'Task')
                  : largeTitle ? '' : 'Scheduled tasks'}
            </span>
          </span>
        }
        subtitle={
          !largeTitle && (!isMobile || mobilePane === 'list') && !tasksQuery.isLoading
            ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}`
            : undefined
        }
        onClose={close}
        closeLabel="Close scheduled tasks"
        back={isMobile && mobilePane !== 'list'
          ? { label: 'Scheduled', onBack: handleBackToList, ariaLabel: 'Back to task list' }
          : undefined}
        actions={
          <>
            {!isMobile && tasks.length > 0 && (selectedTaskId !== null || !creating) && (
              <Button size="sm" className="md:h-7" onClick={handleOpenCreate}>
                <Plus size={12} aria-hidden="true" />
                New task
              </Button>
            )}
            {isMobile && mobilePane === 'list' && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="icon-sm" className="md:size-7" onClick={handleOpenCreate} aria-label="New task">
                      <Plus size={13} />
                    </Button>
                  }
                />
                <TooltipContent>New task</TooltipContent>
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
            {largeTitle && (
              <div className="px-4 pt-2 pb-2">
                <h1 className="text-large-title font-bold text-(--color-text)">Scheduled</h1>
                {!tasksQuery.isLoading && <p className="text-xs text-(--color-text-muted)">{`${tasks.length} task${tasks.length === 1 ? '' : 's'}`}</p>}
              </div>
            )}
            <TaskListPane
              tasks={tasks}
              isLoading={tasksQuery.isLoading}
              isError={tasksQuery.isError}
              onRetry={() => void refetchTasks()}
              selectedTaskId={selectedTaskId}
              onSelect={handleSelectTask}
              onDeleted={handleTaskDeleted}
              // Phones open the create form from the empty state. The desktop
              // overlay already shows it beside an empty list: go to its title.
              onCreate={isMobile ? handleOpenCreate : () => detailRef.current?.querySelector<HTMLElement>('#task-title')?.focus()}
            />
          </div>
        )}

        {/* Detail / Create panel */}
        {showDetail && (
          // Container, not viewport, breakpoints: the same forms render in
          // the review dock's Schedule tab at a fraction of the window.
          <div ref={detailRef} className="@container flex flex-1 flex-col overflow-hidden">
            {selectedTask && (!isMobile || mobilePane === 'detail') ? (
              <TaskDetailView
                key={selectedTask.id}
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
