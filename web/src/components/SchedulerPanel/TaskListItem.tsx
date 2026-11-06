import { useRef, useState } from 'react'
import { Loader2, MoreHorizontal, Pause, Play, Trash2, Zap } from 'lucide-react'
import { ActionSheet } from '@/components/ui/action-sheet'
import { useTouchFirst } from '@/hooks/use-touch-first'
import type { ScheduledTaskResponse } from '@/api/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePauseScheduledTaskMutation, useResumeScheduledTaskMutation, useTriggerScheduledTaskMutation } from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { ROW_ACTION, listRowSurface } from '@/components/ui/list-row'
import { TEXT } from '@/components/ui/panel-tokens'
import { formatScheduleLabel, lastRunLabel, nextRunLabel, taskState, TASK_LONG_PRESS_MOVE_TOLERANCE, TASK_LONG_PRESS_MS } from './utils'
import { Chip } from '@/components/ui/chip'
import { WorkspaceBadge } from './ModeBadge'
import { DeleteTaskDialog } from './DeleteTaskDialog'
import { TaskActionsMenu, taskActionsMenuPoint } from './TaskActionsMenu'

export function TaskListItem({
  task,
  isSelected,
  onSelect,
  onDeleted,
}: {
  task: ScheduledTaskResponse
  isSelected: boolean
  onSelect: () => void
  onDeleted: () => void
}) {
  const pauseMutation = usePauseScheduledTaskMutation()
  const resumeMutation = useResumeScheduledTaskMutation()
  const triggerMutation = useTriggerScheduledTaskMutation()
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const [actionsPoint, setActionsPoint] = useState<{ x: number; y: number } | null>(null)
  // A phone's menu is an action sheet, from ⋯ or a long press alike.
  const phoneSheet = useTouchFirst() && isMobile
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }

  const triggerTask = () => triggerMutation.mutate(task.slug)
  const togglePaused = () => {
    if (task.status === 'paused') resumeMutation.mutate(task.slug)
    else pauseMutation.mutate(task.slug)
  }

  const state = taskState(task)
  const nextRun = nextRunLabel(task)
  const actionPending = triggerMutation.isPending || pauseMutation.isPending || resumeMutation.isPending

  return (
    <>
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect()
      }}
      onContextMenu={(event) => {
        if (isTauriMobile) return
        event.preventDefault()
        setActionsPoint({ x: event.clientX, y: event.clientY })
      }}
      onPointerDown={(event) => {
        if (!isMobile || !isTauriMobile || event.pointerType === 'mouse') return
        longPressStartRef.current = { x: event.clientX, y: event.clientY }
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null
          longPressStartRef.current = null
          mediumHapticFeedback()
          setActionsPoint({ x: event.clientX, y: event.clientY })
        }, TASK_LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        const start = longPressStartRef.current
        if (!start) return
        if (
          Math.abs(event.clientX - start.x) > TASK_LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(event.clientY - start.y) > TASK_LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearLongPress()
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      aria-current={isSelected || undefined}
      className={cn(
        'group relative min-h-16 w-full px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)',
        listRowSurface(isSelected),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className={cn('truncate', TEXT.label)}>{task.name}</p>
            {task.slug !== task.name && (
              <Chip mono title="Slug: the name the agent's schedule tool uses">
                {task.slug}
              </Chip>
            )}
          </div>

          <p className="mt-1 truncate font-mono text-meta text-(--color-text-2)">{formatScheduleLabel(task)}</p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <WorkspaceBadge task={task} />
            <Chip tone={state.tone} spinner={state.spinner}>
              {state.label}
            </Chip>
          </div>

          <p className={cn('mt-1.5 truncate', TEXT.hint)}>
            {lastRunLabel(task)}
            {nextRun && ` · ${nextRun.replace('Next run', 'next')}`}
          </p>

          {task.last_error && (
            <p className="mt-1 truncate text-meta text-(--color-error)" title={task.last_error}>
              {task.last_error}
            </p>
          )}
        </div>

        {/* One ⋯ on every platform (24px, 36px on touch) opens the menu with
            Run now, Pause / Resume and Delete in words: the same menu as a
            right-click or a long press. It shows a spinner while one runs. */}
        <div className="-mr-1.5 flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setActionsPoint(taskActionsMenuPoint(e.currentTarget))
                  }}
                  // Enter and Space here must not reach the row, which would open the task.
                  onKeyDown={(e) => e.stopPropagation()}
                  className={ROW_ACTION}
                  aria-haspopup="menu"
                  aria-label={`More actions for ${task.name}`}
                >
                  {actionPending
                    ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    : <MoreHorizontal size={12} aria-hidden="true" />}
                </button>
              }
            />
            <TooltipContent>Run now, pause or delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
    {phoneSheet ? (
      <ActionSheet
        open={actionsPoint !== null}
        onClose={() => setActionsPoint(null)}
        title={task.name}
        items={[
          { id: 'run', label: 'Run now', icon: Zap, disabled: triggerMutation.isPending, run: triggerTask },
          task.status === 'paused'
            ? { id: 'resume', label: 'Resume', icon: Play, run: togglePaused }
            : { id: 'pause', label: 'Pause', icon: Pause, run: togglePaused },
          { id: 'delete', label: 'Delete task…', icon: Trash2, danger: true, separatorBefore: true, run: () => setDeleteConfirmationOpen(true) },
        ]}
      />
    ) : actionsPoint && (
      <TaskActionsMenu
        task={task}
        at={actionsPoint}
        onDismiss={() => setActionsPoint(null)}
        onRun={triggerTask}
        runPending={triggerMutation.isPending}
        onTogglePause={togglePaused}
        pausePending={pauseMutation.isPending || resumeMutation.isPending}
        onDelete={() => setDeleteConfirmationOpen(true)}
      />
    )}
    <DeleteTaskDialog
      task={task}
      open={deleteConfirmationOpen}
      onOpenChange={setDeleteConfirmationOpen}
      onDeleted={onDeleted}
    />
    </>
  )
}
