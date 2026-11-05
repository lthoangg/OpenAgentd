/**
 * The menu of a scheduled task's actions, in words: Run now, Pause / Resume,
 * and Delete task… last, in the destructive style. One menu for a row's ⋯, a
 * right-click, a long press, and the ⋯ in the task's detail header. A host
 * leaves out the actions it already shows as buttons (the detail header has
 * Run now of its own) by not passing their handler.
 */
import { Pause, Play, Trash2, Zap } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { CONTEXT_MENU_ITEM_CLASS, CONTEXT_MENU_ITEM_DANGER_CLASS, ContextMenu } from '@/components/ui/context-menu'

/** Width the menu is laid out for, so it opens right-aligned under a ⋯ button. */
export const TASK_ACTIONS_MENU_WIDTH = 176

/** Where to open the menu so it hangs right-aligned under `button`. */
export function taskActionsMenuPoint(button: HTMLElement): { x: number; y: number } {
  const rect = button.getBoundingClientRect()
  return { x: rect.right - TASK_ACTIONS_MENU_WIDTH, y: rect.bottom + 2 }
}

export function TaskActionsMenu({
  task,
  at,
  onDismiss,
  onRun,
  runPending = false,
  onTogglePause,
  pausePending = false,
  onDelete,
}: {
  task: ScheduledTaskResponse
  at: { x: number; y: number }
  onDismiss: () => void
  onRun?: () => void
  runPending?: boolean
  onTogglePause?: () => void
  pausePending?: boolean
  /** Opens the delete confirmation. */
  onDelete: () => void
}) {
  const paused = task.status === 'paused'
  return (
    <ContextMenu at={at} label={`Actions for ${task.name}`} onDismiss={onDismiss} className="min-w-44">
      {onRun && (
        <button
          type="button"
          role="menuitem"
          disabled={runPending}
          className={CONTEXT_MENU_ITEM_CLASS}
          onClick={() => {
            onDismiss()
            onRun()
          }}
        >
          <Zap size={12} aria-hidden="true" />
          Run now
        </button>
      )}
      {onTogglePause && (
        <button
          type="button"
          role="menuitem"
          disabled={pausePending}
          className={CONTEXT_MENU_ITEM_CLASS}
          onClick={() => {
            onDismiss()
            onTogglePause()
          }}
        >
          {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={CONTEXT_MENU_ITEM_DANGER_CLASS}
        onClick={() => {
          onDismiss()
          onDelete()
        }}
      >
        <Trash2 size={12} aria-hidden="true" />
        Delete task…
      </button>
    </ContextMenu>
  )
}
