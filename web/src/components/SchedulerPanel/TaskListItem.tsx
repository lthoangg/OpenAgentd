import { useRef, useState } from 'react'
import { Loader2, Pause, Play, Trash2, Zap } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { Button } from '@/components/ui/button'
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
      className={`w-full rounded-sm border px-3 py-2 text-left transition-colors ${
        isSelected
          ? 'border-(--color-border-strong) bg-(--bg-key)/40'
          : 'border-(--color-border) bg-(--bg-card) hover:border-(--color-border-strong) hover:bg-(--color-surface)'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="truncate text-sm font-medium text-(--color-text)">{task.name}</p>
            <span className="font-mono text-[10px] text-(--color-text-muted) break-all">
              {slugify(task.name)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-(--color-text-muted)">
            {formatScheduleLabel(task)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <ModeBadge task={task} />
            <span className={`text-xs font-medium ${statusColor}`}>{task.status}</span>
          </div>
          {task.last_error && (
            <p className="mt-1 truncate text-xs text-(--color-error)">{task.last_error}</p>
          )}
          {task.next_fire_at && (
            <p className="mt-1 text-xs text-(--color-text-muted)">
              Next: {formatRelativeDate(task.next_fire_at)}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex shrink-0 gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation()
              triggerTask()
            }}
            disabled={triggerMutation.isPending}
            title="Trigger now"
          >
            {triggerMutation.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Zap size={13} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation()
              togglePaused()
            }}
            disabled={pauseMutation.isPending || resumeMutation.isPending}
            title={task.status === 'paused' ? 'Resume' : 'Pause'}
          >
            {pauseMutation.isPending || resumeMutation.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : task.status === 'paused' ? (
              <Play size={13} />
            ) : (
              <Pause size={13} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation()
              setDeleteConfirmationOpen(true)
            }}
            disabled={deleteMutation.isPending}
            title="Delete"
            className="hover:bg-(--color-error-subtle) hover:text-(--color-error)"
          >
            {deleteMutation.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
          </Button>
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
