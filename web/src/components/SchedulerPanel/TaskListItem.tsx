import { useRef, useState } from 'react'
import { AlertCircle, CalendarClock, Clock, Loader2, Pause, Play, Trash2, Zap } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDeleteScheduledTaskMutation, usePauseScheduledTaskMutation, useResumeScheduledTaskMutation, useTriggerScheduledTaskMutation } from '@/queries'
import { formatRelativeDate } from '@/utils/format'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { formatScheduleLabel, slugify, TASK_LONG_PRESS_MOVE_TOLERANCE, TASK_LONG_PRESS_MS } from './utils'
import { ModeBadge } from './ModeBadge'

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

  const statusColor = {
    pending: 'text-(--color-text-muted)',
    running: 'text-(--color-accent)',
    paused: 'text-(--color-warning)',
    completed: 'text-(--color-success)',
    failed: 'text-(--color-error)',
  }[task.status] ?? 'text-(--color-text-muted)'

  const statusBadgeStyle = {
    pending: 'bg-(--bg-key)/80 text-(--color-text-muted) border-(--color-border-subtle)',
    running: 'bg-(--color-info-subtle) text-(--color-info) border-(--color-info)/30',
    paused: 'bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning)/30',
    completed: 'bg-(--color-success-subtle) text-(--color-success) border-(--color-success)/30',
    failed: 'bg-(--color-error-subtle) text-(--color-error) border-(--color-error)/30',
  }[task.status] ?? 'bg-(--bg-key)/80 text-(--color-text-muted) border-(--color-border-subtle)'

  const statusDotColor = {
    pending: 'bg-(--color-text-muted)',
    running: 'bg-(--color-info) animate-pulse',
    paused: 'bg-(--color-warning)',
    completed: 'bg-(--color-success)',
    failed: 'bg-(--color-error)',
  }[task.status] ?? 'bg-(--color-text-muted)'

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
      className={`group relative w-full rounded-sm border p-2.5 text-left transition-colors ${
        isSelected
          ? 'border-(--color-border-strong) bg-(--bg-key)/50 ring-1 ring-(--color-accent)/30'
          : 'border-(--color-border) bg-(--bg-card) hover:border-(--color-border-strong) hover:bg-(--color-surface)'
      }`}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-(--color-text)">{task.name}</p>
            <span className="rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/70 px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-subtle) break-all">
              {slugify(task.name)}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-1.5 text-xs text-(--color-text-muted)">
            <CalendarClock size={12} className="shrink-0 text-(--color-text-muted)" />
            <span className="truncate">{formatScheduleLabel(task)}</span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ModeBadge task={task} />
            <span className={`inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-[10.5px] font-medium capitalize ${statusBadgeStyle}`}>
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDotColor}`} aria-hidden="true" />
              <span className={statusColor}>{task.status}</span>
            </span>
          </div>

          {task.last_error && (
            <div className="mt-1.5 flex items-center gap-1 rounded-xs bg-(--color-error-subtle) px-1.5 py-0.5 text-[11px] text-(--color-error)">
              <AlertCircle size={11} className="shrink-0" />
              <p className="truncate">{task.last_error}</p>
            </div>
          )}

          {task.next_fire_at && (
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-(--color-text-muted)">
              <Clock size={11} className="shrink-0 text-(--color-text-muted)" />
              <span>Next: {formatRelativeDate(task.next_fire_at)}</span>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    triggerTask()
                  }}
                  disabled={triggerMutation.isPending}
                  aria-label="Trigger now"
                  className="h-7 w-7 rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
                >
                  {triggerMutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Zap size={12} />
                  )}
                </Button>
              }
            />
            <TooltipContent>Trigger now</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePaused()
                  }}
                  disabled={pauseMutation.isPending || resumeMutation.isPending}
                  aria-label={task.status === 'paused' ? 'Resume' : 'Pause'}
                  className="h-7 w-7 rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteConfirmationOpen(true)
                  }}
                  disabled={deleteMutation.isPending}
                  aria-label="Delete"
                  className="h-7 w-7 rounded-sm text-(--color-text-muted) hover:bg-(--color-error-subtle) hover:text-(--color-error)"
                >
                  {deleteMutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                </Button>
              }
            />
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
    {actionsPoint && (
      <div
        className="fixed inset-0 z-[70]"
        onClick={() => setActionsPoint(null)}
        onContextMenu={(event) => {
          event.preventDefault()
          setActionsPoint(null)
        }}
      >
        <div
          role="menu"
          aria-label={`Actions for ${task.name}`}
          className="fixed min-w-44 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
          style={{ left: actionsPoint.x, top: actionsPoint.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              triggerTask()
            }}
          >
            <Zap size={12} aria-hidden="true" />
            Trigger now
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
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
            className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              setDeleteConfirmationOpen(true)
            }}
          >
            <Trash2 size={12} aria-hidden="true" />
            Delete task
          </button>
        </div>
      </div>
    )}
    <Dialog open={deleteConfirmationOpen} onOpenChange={setDeleteConfirmationOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete scheduled task</DialogTitle>
          <DialogDescription>
            &ldquo;{task.name}&rdquo; will be permanently deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="p-3">
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
