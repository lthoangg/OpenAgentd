import { useRef, useState } from 'react'
import { Loader2, Pause, Play, Trash2, Zap } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { Button } from '@/components/ui/button'
import { CONTEXT_MENU_ITEM_CLASS, CONTEXT_MENU_ITEM_DANGER_CLASS, ContextMenu } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDeleteScheduledTaskMutation, usePauseScheduledTaskMutation, useResumeScheduledTaskMutation, useTriggerScheduledTaskMutation } from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { listRowSurface } from '@/components/ui/list-row'
import { TEXT } from '@/components/ui/panel-tokens'
import { formatScheduleLabel, lastRunLabel, nextRunLabel, taskState, TASK_LONG_PRESS_MOVE_TOLERANCE, TASK_LONG_PRESS_MS } from './utils'
import { Chip } from '@/components/ui/chip'
import { WorkspaceBadge } from './ModeBadge'

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
  const deleteMutation = useDeleteScheduledTaskMutation()
  const pauseMutation = usePauseScheduledTaskMutation()
  const resumeMutation = useResumeScheduledTaskMutation()
  const triggerMutation = useTriggerScheduledTaskMutation()
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const [actionsPoint, setActionsPoint] = useState<{ x: number; y: number } | null>(null)
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
  const deleteTask = () => {
    deleteMutation.mutate(task.slug, {
      onSuccess: () => {
        setDeleteConfirmationOpen(false)
        onDeleted()
      },
    })
  }

  const state = taskState(task)
  const nextRun = nextRunLabel(task)

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
            <p className={cn('truncate', TEXT.label, isSelected && 'font-semibold')}>{task.name}</p>
            {task.slug !== task.name && (
              <Chip mono variant="outline" title="Slug: the name the agent's schedule tool uses">
                {task.slug}
              </Chip>
            )}
          </div>

          <p className="mt-1 truncate font-mono text-[11px] text-(--color-text-2)">{formatScheduleLabel(task)}</p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <WorkspaceBadge task={task} />
            <Chip tone={state.tone} dot={state.dot}>
              {state.label}
            </Chip>
          </div>

          <p className={cn('mt-1.5 truncate', TEXT.hint)}>
            {lastRunLabel(task)}
            {nextRun && ` · ${nextRun.replace('Next run', 'next')}`}
          </p>

          {task.last_error && (
            <p className="mt-1 truncate text-[11px] text-(--color-error)" title={task.last_error}>
              {task.last_error}
            </p>
          )}
        </div>

        {/* Action buttons. Hidden on touch, where they squeezed the name: a tap
            opens the detail (which has every action) and a long press opens
            the same menu. */}
        <div className="-mr-1.5 flex shrink-0 items-center gap-0.5 pointer-coarse:hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    triggerTask()
                  }}
                  disabled={triggerMutation.isPending}
                  aria-label="Run now"
                  className="text-(--color-text-muted) hover:text-(--color-text)"
                >
                  {triggerMutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Zap size={12} />
                  )}
                </Button>
              }
            />
            <TooltipContent>Run now</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePaused()
                  }}
                  disabled={pauseMutation.isPending || resumeMutation.isPending}
                  aria-label={task.status === 'paused' ? 'Resume' : 'Pause'}
                  className="text-(--color-text-muted) hover:text-(--color-text)"
                >
                  {pauseMutation.isPending || resumeMutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : task.status === 'paused' ? (
                    <Play size={12} />
                  ) : (
                    <Pause size={12} />
                  )}
                </Button>
              }
            />
            <TooltipContent>{task.status === 'paused' ? 'Resume' : 'Pause'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
    {actionsPoint && (
      <ContextMenu
        at={actionsPoint}
        label={`Actions for ${task.name}`}
        onDismiss={() => setActionsPoint(null)}
        className="min-w-44"
        layerClassName="z-70"
      >
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => {
              setActionsPoint(null)
              triggerTask()
            }}
          >
            <Zap size={12} aria-hidden="true" />
            Run now
          </button>
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => {
              setActionsPoint(null)
              togglePaused()
            }}
          >
            {task.status === 'paused' ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
            {task.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_DANGER_CLASS}
            onClick={() => {
              setActionsPoint(null)
              setDeleteConfirmationOpen(true)
            }}
          >
            <Trash2 size={12} aria-hidden="true" />
            Delete task…
          </button>
      </ContextMenu>
    )}
    <Dialog open={deleteConfirmationOpen} onOpenChange={setDeleteConfirmationOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete scheduled task</DialogTitle>
          <DialogDescription>
            &ldquo;{task.name}&rdquo; will be permanently deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="default" onClick={() => setDeleteConfirmationOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            aria-label="Delete task permanently"
            onClick={deleteTask}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending && <Loader2 size={13} className="animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}

// ── Create task form ────────────────────────────────────────────────────────
