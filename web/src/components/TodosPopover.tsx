/**
 * TodosPopover — task-list popover surfaced from the team-chat topbar.
 *
 * Renders the agent's task list as a flat, scrollable checklist (no
 * kanban columns, no priority badges). Each row is a status-aware
 * icon + content line:
 *
 *   - pending     → empty circle (thin, muted)
 *   - in_progress → spinning loader (blue)
 *   - completed   → checkmark (green, content struck through + dimmed)
 *   - cancelled   → minus/dash (subtle, content struck through + dimmed)
 *
 * Sort order keeps the user's eye on what matters right now:
 *   in_progress → pending → completed → cancelled
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Circle, ListTodo, Loader2, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { TopbarAction } from '@/components/ui/topbar-action'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import type { TodoItem } from '@/api/types'

// ── Status → row style ──────────────────────────────────────────────────────

const STATUS_ICON: Record<TodoItem['status'], LucideIcon> = {
  completed: Check,
  cancelled: Minus,
  in_progress: Loader2,
  pending: Circle,
}

const STATUS_ICON_COLOR: Record<TodoItem['status'], string> = {
  completed: 'text-(--color-success)',
  cancelled: 'text-(--color-text-subtle)',
  in_progress: 'text-(--color-info)',
  pending: 'text-(--color-text-muted)',
}

// Sort priority for the flat list — most actionable first.
const STATUS_ORDER: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

function getAgentLabel(todo: TodoItem): string | null {
  return todo.claimed_by ?? todo.assigned_to ?? null
}

interface DesktopPopoverPosition {
  top: number
  left: number
}

// ── Component ────────────────────────────────────────────────────────────────

interface TodosPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  todos: TodoItem[]
  /** When null/undefined the trigger is disabled (no active session). */
  sessionId: string | null
  /** Render the topbar trigger. Set false when another control opens this popover. */
  trigger?: boolean
}

export function TodosPopover({
  open,
  onOpenChange,
  todos,
  sessionId,
  trigger = true,
}: TodosPopoverProps) {
  // "Finished" includes cancelled — once a task leaves the active set
  // (whether shipped or dropped) it no longer needs attention.
  const finishedCount = todos.filter(
    (t) => t.status === 'completed' || t.status === 'cancelled',
  ).length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')
  const progressLabel =
    todos.length > 0 ? `${finishedCount}/${todos.length}` : undefined
  const progressPct =
    todos.length > 0 ? Math.round((finishedCount / todos.length) * 100) : 0
  const allDone = todos.length > 0 && finishedCount === todos.length
  const sortedTodos = useMemo(
    () => [...todos].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    [todos],
  )

  const { os } = usePlatform()
  const { mounted, closing } = useDeferredUnmount(open, 100)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const desktopPanelRef = useRef<HTMLDivElement | null>(null)
  const [desktopPosition, setDesktopPosition] = useState<DesktopPopoverPosition | null>(null)

  useEffect(() => {
    if (!trigger || !mounted) {
      setDesktopPosition(null)
      return
    }

    const updateDesktopPosition = () => {
      const triggerEl = triggerRef.current
      const panelEl = desktopPanelRef.current
      if (!triggerEl) return

      const triggerRect = triggerEl.getBoundingClientRect()
      const panelWidth = panelEl?.offsetWidth ?? Math.min(window.innerWidth - 16, 320)
      const panelHeight = panelEl?.offsetHeight ?? 280
      const gap = 8
      const left = Math.max(8, Math.min(triggerRect.right - panelWidth, window.innerWidth - panelWidth - 8))
      const preferredTop = triggerRect.bottom + gap
      const top = preferredTop + panelHeight > window.innerHeight
        ? Math.max(8, triggerRect.top - panelHeight - gap)
        : preferredTop

      setDesktopPosition({ top, left })
    }

    updateDesktopPosition()
    window.addEventListener('resize', updateDesktopPosition)
    window.addEventListener('scroll', updateDesktopPosition, { passive: true, capture: true })

    return () => {
      window.removeEventListener('resize', updateDesktopPosition)
      window.removeEventListener('scroll', updateDesktopPosition, { capture: true })
    }
  }, [open, trigger, mounted])

  useHotkey('Escape', () => onOpenChange(false), { enabled: Boolean(trigger && open) })

  useEffect(() => {
    if (!trigger || !open) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || desktopPanelRef.current?.contains(target)) return
      onOpenChange(false)
    }

    document.addEventListener('mousedown', handlePointerDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [onOpenChange, open, trigger])

  const content = (
    <>
      <div className="flex items-center justify-between border-b border-(--color-border-subtle) px-2.5 py-2">
        <span className="text-[11px] font-medium text-(--color-text)">Tasks</span>
        {todos.length > 0 && (
          <span
            className={cn(
              'font-mono text-[10px] tabular-nums text-(--color-text-subtle)',
              allDone && 'text-(--color-success)',
            )}
          >
            {finishedCount}/{todos.length} done
          </span>
        )}
      </div>

      {todos.length > 0 && (
        <div
          className="h-px w-full bg-(--color-border-subtle)"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Task completion"
        >
          <div
            className={cn(
              'h-full transition-[width] duration-300 ease-out',
              allDone ? 'bg-(--color-success)' : 'bg-(--color-info)'
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {todos.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-1 px-3 py-5 text-center"
        >
          <ListTodo
            size={14}
            aria-hidden="true"
            className="text-(--color-text-subtle) opacity-40"
          />
          <p className="text-xs text-(--color-text-subtle)">
            No tasks yet
          </p>
        </div>
      ) : (
        <ul
          aria-label="Task list"
          className="scrollbar-none max-h-[min(46vh,17rem)] overflow-y-auto overscroll-contain px-1.5 py-1"
        >
          {sortedTodos.map((todo) => {
            const Icon = STATUS_ICON[todo.status]
            const isStruck =
              todo.status === 'completed' || todo.status === 'cancelled'
            const isInProgress = todo.status === 'in_progress'
            const agent = getAgentLabel(todo)
            return (
              <li
                key={todo.task_id}
                className={cn(
                  'group flex gap-2 rounded-md px-2 py-1.5 transition-colors',
                  agent ? 'items-start' : 'items-center',
                  isInProgress
                    ? 'bg-(--color-info-subtle) text-(--color-text)'
                    : 'hover:bg-(--bg-key)/50'
                )}
              >
                <Icon
                  size={12}
                  aria-hidden="true"
                  className={cn(
                    'shrink-0',
                    agent && 'mt-0.5',
                    STATUS_ICON_COLOR[todo.status],
                    isInProgress && 'animate-spin'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <Tooltip className="w-full">
                    <TooltipTrigger
                      render={
                        <div
                          className={cn(
                            'truncate text-[12px] leading-4',
                            isStruck
                              ? 'text-(--color-text-subtle) line-through decoration-(--color-text-subtle)/40'
                              : isInProgress
                                ? 'font-medium text-(--color-text)'
                                : 'text-(--color-text-2)'
                          )}
                        >
                          {todo.content}
                        </div>
                      }
                    />
                    <TooltipContent>{todo.content}</TooltipContent>
                  </Tooltip>
                  {agent && (
                    <div className="mt-0.5 text-[10px] text-(--color-text-subtle)">
                      {agent}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )

  if (!trigger) {
    if (!mounted) return null
    return (
      <div
        className="fixed inset-0 z-50 pointer-events-none"
        role="presentation"
        // Not tracked by useEdgeSwipe's drawer set — without this an
        // edge-zone touch on the backdrop/panel is read as a fresh "open"
        // gesture for the sidebar/actions drawer underneath.
        data-swipe-ignore
      >
        {/*
          The dismiss backdrop must NOT cover the app header — otherwise a
          tap on the Tasks / Files / panel buttons lands on the backdrop
          (closing this popover) instead of toggling the target surface.
          Start it below the header so those header actions stay live.
        */}
        <button
          type="button"
          className={cn(
            'absolute inset-x-0 bottom-0 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px))] cursor-default bg-black/15 backdrop-blur-[1px] transition-opacity duration-100 ease-out pointer-events-auto',
            closing ? 'opacity-0' : 'opacity-100'
          )}
          aria-label="Close tasks"
          onClick={() => onOpenChange(false)}
        />
        <section
          role="dialog"
          aria-label="Tasks"
          className={cn(
            'absolute right-2 top-[calc(var(--spacing-app-header)+env(safe-area-inset-top,0px)+0.5rem)] w-[min(calc(100vw-1rem),20rem)] overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-card) p-0 shadow-lg ring-1 ring-black/5 pointer-events-auto',
            closing
              ? 'animate-out fade-out-0 zoom-out-95 duration-100 ease-out'
              : 'animate-in fade-in-0 duration-100 ease-out'
          )}
        >
          {content}
        </section>
      </div>
    )
  }

  return (
    <>
      {trigger && (
        <Tooltip>
          <TooltipTrigger
            render={
              <TopbarAction
                ref={triggerRef}
                Icon={ListTodo}
                indicator={hasInProgress}
                indicatorClassName="bg-(--color-info)"
                badge={progressLabel}
                aria-label="Task list"
                aria-expanded={open}
                disabled={!sessionId}
                onClick={() => {
                  if (!sessionId) return
                  onOpenChange(!open)
                }}
                data-state={open ? 'open' : 'closed'}
                className={
                  open
                    ? 'border border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
                    : undefined
                }
              />
            }
          />
          <TooltipContent>{sessionId ? `Task list (${formatShortcut('T', os)})` : 'No active session'}</TooltipContent>
        </Tooltip>
      )}

      {trigger && mounted && (
        <div
          ref={desktopPanelRef}
          data-slot="popover-content"
          className={cn(
            'fixed z-50 w-[min(calc(100vw-1rem),20rem)] overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-card) p-0 shadow-lg ring-1 ring-black/5',
            closing
              ? 'animate-out fade-out-0 zoom-out-95 duration-100 ease-out'
              : 'animate-in fade-in-0 duration-100 ease-out'
          )}
          style={{
            top: desktopPosition?.top ?? 0,
            left: desktopPosition?.left ?? 0,
            visibility: desktopPosition ? 'visible' : 'hidden',
          }}
        >
          {content}
        </div>
      )}
    </>
  )
}
