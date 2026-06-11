/**
 * SchedulerPanel — modal overlay for managing scheduled tasks.
 *
 * Mirrors MemoryPanel structure: fixed overlay with right-sliding drawer,
 * backdrop click to close, and X close button.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Clock, Play, Pause, Trash2, Plus, Loader2, AlertCircle, CalendarClock, Zap, ArrowLeft, Pencil, FolderOpen } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  useScheduledTasksQuery,
  useCreateScheduledTaskMutation,
  useUpdateScheduledTaskMutation,
  useDeleteScheduledTaskMutation,
  usePauseScheduledTaskMutation,
  useResumeScheduledTaskMutation,
  useTriggerScheduledTaskMutation,
} from '@/queries'
import type { ScheduledTaskResponse, ScheduledTaskCreate, ScheduledTaskMode } from '@/api/types'
import { formatRelativeDate, formatInTimezone, wallClockToISO, isoToWallClock } from '@/utils/format'
import { useIsMobile } from '@/hooks/use-mobile'
import { useModalFocus } from '@/hooks/useModalFocus'
import { loadCodingWorkspaceEntries, workspaceLabel } from '@/utils/workspace'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'

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

// ── Shared utility ──────────────────────────────────────────────────────────

// Form fields sit on a bg-(--bg-card) panel; the shared <Input>/<Textarea>/
// <SelectTrigger> primitives default to bg-transparent which leaves them
// indistinguishable from the parent. Give them an explicit fillable surface
// so the controls read as inputs.
const FIELD_CLASS = 'bg-(--bg-page) dark:bg-(--bg-page)'

// Inline className for SelectContent — the global default (`bg-popover`)
// resolves to `--bg-card`, the same surface as this drawer, so the dropdown
// looks like an outlined frame floating on the same paper. Use the page
// surface for clear contrast and soften the border.
const SELECT_CONTENT_CLASS = 'bg-(--bg-page) border-(--color-border-strong)'
const TASK_LONG_PRESS_MS = 520
const TASK_LONG_PRESS_MOVE_TOLERANCE = 10

// Three-option segmented control used for "Schedule type". The shared Tabs
// primitive inverts in light mode (track = bg-key which is darker than the
// active bg-background = bg-page), so we render a flat row of buttons that
// match the rest of this drawer's surfaces.
function ScheduleTypeSegmented({
  value,
  onChange,
}: {
  value: ScheduledTaskCreate['schedule_type']
  onChange: (v: ScheduledTaskCreate['schedule_type']) => void
}) {
  const options: { key: ScheduledTaskCreate['schedule_type']; label: string }[] = [
    { key: 'every', label: 'Every' },
    { key: 'cron', label: 'Cron' },
    { key: 'at', label: 'At' },
  ]
  return (
    <div
      role="tablist"
      aria-label="Schedule type"
      // ``inline-flex`` (not ``flex w-full``) so the control sizes to its
      // contents — three short labels do not need the full form width.
      className="mt-2 inline-flex gap-1 rounded-md border border-(--color-border) bg-(--bg-page) p-1"
    >
      {options.map((opt) => {
        const active = value === opt.key
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.key)}
            className={
              // Drop ``flex-1`` — let each button hug its label with
              // comfortable horizontal padding instead of stretching to
              // fill the container.
              'rounded-sm px-3 py-1 text-xs font-medium transition-colors ' +
              (active
                ? 'bg-(--bg-card) text-(--color-text) shadow-sm ring-1 ring-(--color-border-strong)'
                : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)')
            }
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function formatScheduleLabel(task: Pick<ScheduledTaskResponse, 'schedule_type' | 'at_datetime' | 'every_seconds' | 'cron_expression' | 'timezone'>): string {
  if (task.schedule_type === 'at' && task.at_datetime) {
    // Render in the task's saved timezone, not the browser's — otherwise
    // a task scheduled for "9 AM in New York" displays a different time
    // when viewed from a Vietnam-based browser.
    return `at ${formatInTimezone(task.at_datetime, task.timezone)}`
  }
  if (task.schedule_type === 'every' && task.every_seconds) {
    const mins = Math.floor(task.every_seconds / 60)
    const secs = task.every_seconds % 60
    if (mins > 0 && secs === 0) return `every ${mins}m`
    if (mins === 0) return `every ${secs}s`
    return `every ${mins}m ${secs}s`
  }
  if (task.schedule_type === 'cron' && task.cron_expression) {
    return `cron: ${task.cron_expression}`
  }
  return 'unknown schedule'
}

// ── Mode / workspace shared bits ────────────────────────────────────────────

function ModeBadge({ task }: { task: Pick<ScheduledTaskResponse, 'mode' | 'workspace'> }) {
  if (task.mode === 'coding' && task.workspace) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-(--bg-key) px-2 py-0.5 text-xs text-(--color-text-2) ring-1 ring-(--color-border-strong)"
        title={task.workspace}
      >
        <FolderOpen size={10} className="shrink-0" />
        <span className="truncate">coding · {workspaceLabel(task.workspace)}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-md bg-(--bg-key) px-2 py-0.5 text-xs text-(--color-text-2) ring-1 ring-(--color-border-strong)">
      normal
    </span>
  )
}

/**
 * Mode toggle + workspace input — shared between Create and Edit forms.
 *
 * Workspace control:
 *   - When the caller has a context workspace (scheduler opened inside a
 *     coding chat), the input pre-fills with that path. The user can still
 *     edit it or switch modes.
 *   - Saved coding workspaces from localStorage are surfaced as quick-pick
 *     suggestions via a small `<Select>` next to the path input.
 */
/**
 * Internal subcomponent — exported solely for unit testing the mode/workspace
 * toggle contract. Not part of the public ``SchedulerPanel`` API; do not
 * consume from other modules.
 */
export function ModeWorkspaceFields({
  mode,
  workspace,
  onChange,
}: {
  mode: ScheduledTaskMode
  workspace: string | null
  /** Emits both fields together so the parent applies them in a single
   *  setState — preventing the stale-snapshot bug where switching
   *  ``coding → normal`` would clear the workspace but leave ``mode``
   *  unchanged (two sequential setState calls on the same snapshot). */
  onChange: (next: { mode: ScheduledTaskMode; workspace: string | null }) => void
}) {
  const savedWorkspaces = useMemo(() => {
    const paths = loadCodingWorkspaceEntries().map((entry) => entry.path)
    if (workspace && !paths.includes(workspace)) paths.push(workspace)
    return paths.sort()
  }, [workspace])

  const modeOptions: { key: ScheduledTaskMode; label: string }[] = [
    { key: 'normal', label: 'Normal' },
    { key: 'coding', label: 'Coding' },
  ]

  return (
    <div>
      <label className="block text-sm font-medium text-(--color-text)">Routing</label>
      <div
        role="tablist"
        aria-label="Task mode"
        // ``inline-flex`` so two short labels ("Normal" / "Coding") do not
        // sprawl across the full form width.
        className="mt-2 inline-flex gap-1 rounded-md border border-(--color-border) bg-(--bg-page) p-1"
      >
        {modeOptions.map((opt) => {
          const active = mode === opt.key
          return (
            <button
              key={opt.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                onChange({
                  mode: opt.key,
                  // Drop the workspace when leaving coding mode; preserve it
                  // when staying on coding so the user does not lose their
                  // typed-in path by tapping the active tab.
                  workspace: opt.key === 'coding' ? workspace : null,
                })
              }}
              className={
                'rounded-sm px-3 py-1 text-xs font-medium transition-colors ' +
                (active
                  ? 'bg-(--bg-card) text-(--color-text) shadow-sm ring-1 ring-(--color-border-strong)'
                  : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)')
              }
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      <p className="mt-1 text-xs text-(--color-text-muted)">
        {mode === 'normal'
          ? 'Delivers to the default team lead.'
          : 'Delivers to the lead of the coding team for the workspace below.'}
      </p>

      {mode === 'coding' && (
        <div className="mt-3">
          <label className="block text-sm font-medium text-(--color-text)">Workspace</label>
          <Select
            value={workspace ?? ''}
            onValueChange={(v) => onChange({ mode, workspace: v || null })}
          >
            <SelectTrigger
              className={`mt-1 w-full ${FIELD_CLASS}`}
              aria-label="Select workspace"
            >
              <SelectValue>
                {workspace ? workspaceLabel(workspace) : 'Select a saved workspace…'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className={SELECT_CONTENT_CLASS}>
              {savedWorkspaces.map((path) => (
                <SelectItem key={path} value={path}>
                  {workspaceLabel(path)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-(--color-text-muted)">
            Workspaces come from saved coding workspaces.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Panel root ──────────────────────────────────────────────────────────────

export function SchedulerPanel({
  open,
  onClose,
  contextMode = 'normal',
  contextWorkspace = null,
}: SchedulerPanelProps) {
  const isMobile = useIsMobile()

  // Ephemeral panel-scoped state — not shared outside this component tree,
  // so useState is correct here (no need for Zustand).
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Mobile: 'list' | 'detail' | 'create'
  const [mobilePane, setMobilePane] = useState<'list' | 'detail' | 'create'>('list')

  const tasksQuery = useScheduledTasksQuery()
  const prefersReducedMotion = useReducedMotion()
  useModalFocus(open, onClose)

  // Refresh on open — the drawer is mounted persistently so AnimatePresence
  // can play exit animations; without this the list goes stale on reopen.
  useEffect(() => {
    if (open) {
      tasksQuery.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const tasks = tasksQuery.data?.tasks ?? []

  // Show all scheduled tasks. Each row carries a routing badge so users can
  // distinguish normal reminders from coding-workspace reminders.
  const filteredTasks = tasks.filter((task) => {
    const q = searchQuery.toLowerCase()
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

  // When a task is deleted from the list, drop the selection if it was the
  // currently-selected one — otherwise the detail pane (mobile especially)
  // would render an empty state until the user navigates back manually.
  const handleTaskDeleted = (id: string) => {
    if (selectedTaskId === id) handleCloseDetail()
  }

  const handleOpenCreate = () => {
    if (isMobile) setMobilePane('create')
  }

  const handleBackToList = () => {
    setMobilePane('list')
  }

  // On mobile: show list OR detail/create — never both side-by-side.
  const showList = !isMobile || mobilePane === 'list'
  const showDetail = !isMobile || mobilePane === 'detail' || mobilePane === 'create'

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40"
          />

          <motion.aside
            key="dialog"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="fixed inset-x-0 bottom-0 top-[env(safe-area-inset-top,0px)] z-50 flex flex-col overflow-hidden border-(--color-border) bg-(--bg-card) shadow-2xl sm:left-1/2 sm:top-1/2 sm:inset-auto sm:h-[min(90vh,860px)] sm:w-[min(90vw,1180px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border"
            role="dialog"
            aria-modal="true"
            aria-label="Scheduled tasks"
            data-modal-focus="true"
          >
            {/* Header */}
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) px-5 py-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {/* Mobile back button — shown in detail/create pane */}
                {isMobile && mobilePane !== 'list' && (
                  <button
                    onClick={handleBackToList}
                    className="shrink-0 rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                    aria-label="Back to task list"
                  >
                    <ArrowLeft size={14} />
                  </button>
                )}
                <div className="flex min-w-0 items-center gap-2">
                  <CalendarClock size={18} className="shrink-0 text-(--color-accent)" />
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-(--color-text)">
                      {isMobile && mobilePane === 'create'
                        ? 'Create Task'
                        : isMobile && mobilePane === 'detail'
                          ? (selectedTask?.name ?? 'Task')
                          : 'Scheduled Tasks'}
                    </h2>
                    {(!isMobile || mobilePane === 'list') && (
                      <p
                        className="mt-0.5 truncate text-xs text-(--color-text-muted)"
                        // ``title`` exposes the full workspace path on
                        // hover when the truncated label hides it.
                        title="Normal and coding scheduled tasks"
                      >
                        All scheduled tasks
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Mobile: Create button shown in list pane */}
                {isMobile && mobilePane === 'list' && (
                  <button
                    onClick={handleOpenCreate}
                    className="rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                    aria-label="Create new task"
                    title="Create task"
                  >
                    <Plus size={16} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                  aria-label="Close scheduler panel"
                  title="Close (Esc)"
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            {/* Main content */}
            <div className="flex flex-1 overflow-hidden">
              {/* List panel */}
              {showList && (
                <div className={`flex flex-col border-r border-(--color-border) ${isMobile ? 'w-full' : 'w-96 shrink-0'}`}>
                  {/* Search bar */}
                  <div className="border-b border-(--color-border) p-3">
                    <Input
                      className={FIELD_CLASS}
                      placeholder="Search tasks…"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

                  {/* Task list */}
                  <div className="flex-1 overflow-y-auto">
                    {tasksQuery.isLoading ? (
                      <div className="flex items-center justify-center p-8">
                        <Loader2 size={20} className="animate-spin text-(--color-text-muted)" />
                      </div>
                    ) : tasksQuery.isError ? (
                      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
                        <AlertCircle size={20} className="text-(--color-error)" />
                        <p className="text-sm text-(--color-text-muted)">Failed to load tasks</p>
                      </div>
                    ) : filteredTasks.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
                        <Clock size={20} className="text-(--color-text-muted)" />
                        <p className="text-sm text-(--color-text-muted)">
                          {searchQuery ? 'No tasks match your search' : 'No scheduled tasks yet'}
                        </p>
                        {!searchQuery && !isMobile && (
                          <p className="text-xs text-(--color-text-subtle)">
                            Use the form on the right to create one.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1 p-2">
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
                      contextMode={contextMode}
                      contextWorkspace={contextWorkspace}
                      onSuccess={handleCloseDetail}
                    />
                  )}
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

// ── Task list item ──────────────────────────────────────────────────────────

function TaskListItem({
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
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }

  const triggerTask = () => triggerMutation.mutate(task.id)
  const togglePaused = () => {
    if (task.status === 'paused') resumeMutation.mutate(task.id)
    else pauseMutation.mutate(task.id)
  }
  const deleteTask = () => {
    if (confirm(`Delete task "${task.name}"?`)) {
      deleteMutation.mutate(task.id, { onSuccess: onDeleted })
    }
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
    <button
      onClick={onSelect}
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
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
        isSelected
          ? 'border-(--color-accent) bg-(--bg-key)'
          : 'border-(--color-border) bg-(--bg-page) hover:border-(--color-border-strong)'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-(--color-text)">{task.name}</p>
          <p className="mt-0.5 truncate text-xs text-(--color-text-muted)">
            {formatScheduleLabel(task)}
          </p>
          <div className="mt-1 flex items-center gap-2">
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
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation()
              triggerTask()
            }}
            disabled={triggerMutation.isPending}
            title="Trigger now"
          >
            {triggerMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Zap size={14} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation()
              togglePaused()
            }}
            disabled={pauseMutation.isPending || resumeMutation.isPending}
            title={task.status === 'paused' ? 'Resume' : 'Pause'}
          >
            {pauseMutation.isPending || resumeMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : task.status === 'paused' ? (
              <Play size={14} />
            ) : (
              <Pause size={14} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation()
              deleteTask()
            }}
            disabled={deleteMutation.isPending}
            title="Delete"
            className="hover:bg-(--color-error-subtle) hover:text-(--color-error)"
          >
            {deleteMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
          </Button>
        </div>
      </div>
    </button>
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
          className="fixed min-w-44 rounded-lg border border-(--color-border) bg-(--bg-card) p-1 text-sm text-(--color-text) shadow-xl"
          style={{ left: actionsPoint.x, top: actionsPoint.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              triggerTask()
            }}
          >
            <Zap size={14} aria-hidden="true" />
            Trigger now
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              togglePaused()
            }}
          >
            {task.status === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {task.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              deleteTask()
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete task
          </button>
        </div>
      </div>
    )}
    </>
  )
}

// ── Create task form ────────────────────────────────────────────────────────

function CreateTaskForm({
  contextMode,
  contextWorkspace,
  onSuccess,
}: {
  contextMode: ScheduledTaskMode
  contextWorkspace: string | null
  onSuccess: () => void
}) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const initialMode: ScheduledTaskMode = contextMode
  const initialWorkspace: string | null =
    contextMode === 'coding' ? contextWorkspace : null
  const [formData, setFormData] = useState<ScheduledTaskCreate>({
    name: '',
    mode: initialMode,
    workspace: initialWorkspace,
    schedule_type: 'every',
    every_seconds: 3600,
    timezone: localTz,
    prompt: '',
    enabled: true,
  })
  const [error, setError] = useState<string | null>(null)

  const createMutation = useCreateScheduledTaskMutation()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const mode: ScheduledTaskMode = formData.mode ?? 'normal'
    const workspace = formData.workspace ?? null

    if (!formData.name.trim()) { setError('Task name is required'); return }
    if (mode === 'coding' && !workspace?.trim()) {
      setError('Workspace is required for coding mode'); return
    }
    if (!formData.prompt.trim()) { setError('Prompt is required'); return }
    if (formData.schedule_type === 'at' && !formData.at_datetime) {
      setError('Date/time is required for "at" schedule'); return
    }
    if (formData.schedule_type === 'every' && (!formData.every_seconds || formData.every_seconds <= 0)) {
      setError('Interval must be greater than 0'); return
    }
    if (formData.schedule_type === 'cron' && !formData.cron_expression?.trim()) {
      setError('Cron expression is required'); return
    }

    // Strip fields that don't belong to the active schedule_type.
    // The backend Pydantic validator rejects any extra schedule fields
    // (e.g. every_seconds present when schedule_type='at').
    //
    // For 'at' schedules, DateTimePicker emits a NAIVE wall-clock string
    // ("yyyy-MM-dd'T'HH:mm"). We must combine it with the user-supplied
    // `timezone` before sending — otherwise the backend treats the wall
    // clock as UTC and the task fires at the wrong hour.
    const tz = formData.timezone || localTz
    const atIso = formData.at_datetime ? wallClockToISO(formData.at_datetime, tz) : undefined
    const payload: ScheduledTaskCreate = {
      name: formData.name.trim(),
      mode,
      workspace: mode === 'coding' ? workspace!.trim() : null,
      schedule_type: formData.schedule_type,
      timezone: tz,
      prompt: formData.prompt.trim(),
      session_id: formData.session_id,
      enabled: formData.enabled,
      ...(formData.schedule_type === 'at'    ? { at_datetime: atIso }                          : {}),
      ...(formData.schedule_type === 'every' ? { every_seconds: formData.every_seconds }       : {}),
      ...(formData.schedule_type === 'cron'  ? { cron_expression: formData.cron_expression }   : {}),
    }

    createMutation.mutate(payload, {
      onSuccess: () => {
        setFormData({
          name: '',
          mode: initialMode,
          workspace: initialWorkspace,
          schedule_type: 'every',
          every_seconds: 3600,
          timezone: localTz,
          prompt: '',
          enabled: true,
        })
        onSuccess()
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to create task')
      },
    })
  }

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-(--color-border) px-5 py-4">
        <div className="flex items-center gap-2">
          <Plus size={18} className="text-(--color-accent)" />
          <h2 className="text-base font-semibold text-(--color-text)">Create Task</h2>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Task Name</label>
            <Input
              className={`mt-1 ${FIELD_CLASS}`}
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., Daily Report"
            />
          </div>

          {/* Routing — mode + workspace (mode is auto-injected into the
              schedule_task tool when fired; here the user sets where the
              task should route once the timer fires). */}
          <ModeWorkspaceFields
            mode={formData.mode ?? 'normal'}
            workspace={formData.workspace ?? null}
            onChange={(next) =>
              setFormData((prev) => ({
                ...prev,
                mode: next.mode,
                workspace: next.workspace,
              }))
            }
          />

          {/* Schedule Type */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Schedule Type</label>
            <ScheduleTypeSegmented
              value={formData.schedule_type}
              onChange={(v) => setFormData({ ...formData, schedule_type: v })}
            />
          </div>

          {/* Schedule value (conditional) */}
          {formData.schedule_type === 'at' && (
            <div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-(--color-text)">Date & Time</label>
                  <div className="mt-1">
                    <DateTimePicker
                      value={formData.at_datetime ?? ''}
                      onChange={(v) => setFormData({ ...formData, at_datetime: v })}
                      triggerClassName="bg-(--bg-page) hover:bg-(--bg-page)"
                    />
                  </div>
                </div>
                <div className="w-44 shrink-0">
                  <label className="block text-sm font-medium text-(--color-text)">Timezone</label>
                  <Input
                    className={`mt-1 ${FIELD_CLASS}`}
                    value={formData.timezone}
                    onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                    placeholder={localTz}
                  />
                </div>
              </div>
              <p className="mt-1 text-xs text-(--color-text-muted)">IANA timezone (e.g., America/New_York)</p>
            </div>
          )}

          {formData.schedule_type === 'every' && (
            <div>
              <label className="block text-sm font-medium text-(--color-text)">Interval (seconds)</label>
              <Input
                // Numeric value rarely exceeds 6 digits — constrain to ~9rem
                // so the input does not stretch across the full form width.
                className={`mt-1 w-36 ${FIELD_CLASS}`}
                type="number"
                min="1"
                value={formData.every_seconds ?? 3600}
                onChange={(e) =>
                  setFormData({ ...formData, every_seconds: parseInt(e.target.value) || 0 })
                }
              />
              <p className="mt-1 text-xs text-(--color-text-muted)">e.g., 3600 = 1 hour, 86400 = 1 day</p>
            </div>
          )}

          {formData.schedule_type === 'cron' && (
            <div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-(--color-text)">Cron Expression</label>
                  <Input
                    className={`mt-1 ${FIELD_CLASS}`}
                    value={formData.cron_expression ?? ''}
                    onChange={(e) => setFormData({ ...formData, cron_expression: e.target.value })}
                    placeholder="e.g., 0 9 * * MON-FRI"
                  />
                </div>
                <div className="w-44 shrink-0">
                  <label className="block text-sm font-medium text-(--color-text)">Timezone</label>
                  <Input
                    className={`mt-1 ${FIELD_CLASS}`}
                    value={formData.timezone}
                    onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                    placeholder={localTz}
                  />
                </div>
              </div>
              <p className="mt-1 text-xs text-(--color-text-muted)">IANA timezone (e.g., America/New_York)</p>
            </div>
          )}

          {/* Prompt */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Prompt</label>
            <Textarea
              className={`mt-1 ${FIELD_CLASS}`}
              value={formData.prompt}
              onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
              placeholder="Message to deliver to the team lead when the task fires."
              rows={4}
            />
          </div>

          {/* Session ID */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Session ID (optional)</label>
            <Input
              className={`mt-1 ${FIELD_CLASS}`}
              value={formData.session_id ?? ''}
              onChange={(e) => setFormData({ ...formData, session_id: e.target.value || null })}
              placeholder="Leave blank for new session, or enter 'auto'"
            />
            <p className="mt-1 text-xs text-(--color-text-muted)">
              null = new session each run, "auto" = persistent session, or UUID
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div className="flex gap-2 rounded-lg border border-(--color-error) bg-(--color-error-subtle) p-3">
              <AlertCircle size={16} className="shrink-0 text-(--color-error)" />
              <p className="text-sm text-(--color-error)">{error}</p>
            </div>
          )}
        </div>

        {/* Submit */}
        <Button
          type="submit"
          disabled={createMutation.isPending}
          className="mt-6 w-full"
        >
          {createMutation.isPending ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Creating…
            </>
          ) : (
            <>
              <Plus size={14} />
              Create Task
            </>
          )}
        </Button>
      </form>
    </div>
  )
}

// ── Task detail view ────────────────────────────────────────────────────────

function TaskDetailView({
  task,
  onClose,
}: {
  task: ScheduledTaskResponse
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <EditTaskForm
        task={task}
        onSuccess={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    )
  }

  const statusColor = {
    pending: 'text-(--color-text-muted)',
    running: 'text-(--color-accent)',
    paused: 'text-(--color-warning)',
    completed: 'text-(--color-success)',
    failed: 'text-(--color-error)',
  }[task.status] ?? 'text-(--color-text-muted)'

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-(--color-border) px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-(--color-text)">{task.name}</h2>
            <p className="mt-1 text-sm text-(--color-text-muted)">{formatScheduleLabel(task)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setEditing(true)}
              className="rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
              aria-label="Edit task"
              title="Edit task"
            >
              <Pencil size={16} />
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
              aria-label="Close detail"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Content — sectioned layout matches AgentCapabilities drawer:
          uppercase muted headings, bordered sections, no outer padding. */}
      <div className="flex-1 overflow-y-auto">
        <section className="px-5 py-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
            Status
          </h3>
          <div className="space-y-1.5">
            <DetailRow label="Current">
              <span className={`text-sm font-medium ${statusColor}`}>{task.status}</span>
            </DetailRow>
            <DetailRow label="Enabled">
              <span className="text-sm text-(--color-text)">{task.enabled ? 'Yes' : 'No'}</span>
            </DetailRow>
            <DetailRow label="Run Count">
              <span className="text-sm text-(--color-text)">{task.run_count}</span>
            </DetailRow>
          </div>
        </section>

        <section className="border-t border-(--color-border) px-5 py-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
            Schedule
          </h3>
          <div className="space-y-1.5">
            <DetailRow label="Type">
              <span className="text-sm text-(--color-text) capitalize">{task.schedule_type}</span>
            </DetailRow>
            {task.schedule_type === 'at' && task.at_datetime && (
              <DetailRow label="Date/Time">
                <span className="text-sm text-(--color-text)">
                  {formatInTimezone(task.at_datetime, task.timezone)}
                </span>
              </DetailRow>
            )}
            {task.schedule_type === 'every' && task.every_seconds && (
              <DetailRow label="Interval">
                <span className="text-sm text-(--color-text)">{task.every_seconds}s</span>
              </DetailRow>
            )}
            {task.schedule_type === 'cron' && task.cron_expression && (
              <DetailRow label="Expression">
                <span className="text-sm text-(--color-text)">{task.cron_expression}</span>
              </DetailRow>
            )}
            <DetailRow label="Timezone">
              <span className="text-sm text-(--color-text)">{task.timezone}</span>
            </DetailRow>
          </div>
        </section>

        <section className="border-t border-(--color-border) px-5 py-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
            Configuration
          </h3>
          <div className="space-y-3">
            <div>
              <span className="text-xs text-(--color-text-muted)">Routing</span>
              <p className="mt-1 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 text-sm text-(--color-text)">
                {task.mode === 'coding' ? (
                  <>
                    Coding team
                    {task.workspace && (
                      <span className="ml-1 font-mono text-xs text-(--color-text-muted)">
                        · {task.workspace}
                      </span>
                    )}
                  </>
                ) : (
                  'Default team lead'
                )}
              </p>
            </div>
            <div>
              <span className="text-xs text-(--color-text-muted)">Prompt</span>
              <p className="mt-1 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 text-sm leading-relaxed text-(--color-text) whitespace-pre-wrap">
                {task.prompt}
              </p>
            </div>
            {task.session_id && (
              <div>
                <span className="text-xs text-(--color-text-muted)">Session ID</span>
                <p className="mt-1 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 font-mono text-xs text-(--color-text) break-all">
                  {task.session_id}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="border-t border-(--color-border) px-5 py-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
            Run History
          </h3>
          <div className="space-y-1.5">
            {task.last_run_at && (
              <DetailRow label="Last Run">
                <span className="text-sm text-(--color-text)">
                  {formatRelativeDate(task.last_run_at)}
                </span>
              </DetailRow>
            )}
            {task.next_fire_at && (
              <DetailRow label="Next Fire">
                <span className="text-sm text-(--color-text)">
                  {formatRelativeDate(task.next_fire_at)}
                </span>
              </DetailRow>
            )}
            {!task.last_run_at && !task.next_fire_at && !task.last_error && (
              <p className="text-xs italic text-(--color-text-muted)">No runs yet.</p>
            )}
            {task.last_error && (
              <div className="pt-1">
                <span className="text-xs text-(--color-text-muted)">Last Error</span>
                <p className="mt-1 rounded-md border border-(--color-error) bg-(--color-error-subtle) px-3 py-2 text-xs text-(--color-error) whitespace-pre-wrap">
                  {task.last_error}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="border-t border-(--color-border) px-5 py-3">
          <div className="space-y-1 text-[11px] text-(--color-text-muted)">
            <div>Created: {formatRelativeDate(task.created_at)}</div>
            <div>Updated: {formatRelativeDate(task.updated_at)}</div>
          </div>
        </section>
      </div>
    </div>
  )
}

// Compact label/value row used throughout the detail view.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-(--color-text-muted)">{label}</span>
      {children}
    </div>
  )
}

// ── Edit task form ──────────────────────────────────────────────────────────

function EditTaskForm({
  task,
  onSuccess,
  onCancel,
}: {
  task: ScheduledTaskResponse
  onSuccess: () => void
  onCancel: () => void
}) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  // The API returns `at_datetime` as a tz-aware ISO string, but DateTimePicker
  // expects a naive wall-clock ("yyyy-MM-dd'T'HH:mm") interpreted in the
  // task's timezone. Convert back so the picker shows the correct value.
  const initialAt = task.at_datetime ? isoToWallClock(task.at_datetime, task.timezone) : undefined
  const [formData, setFormData] = useState<ScheduledTaskCreate>({
    name: task.name,
    mode: task.mode,
    workspace: task.workspace,
    schedule_type: task.schedule_type,
    at_datetime: initialAt,
    every_seconds: task.every_seconds ?? undefined,
    cron_expression: task.cron_expression ?? undefined,
    timezone: task.timezone,
    prompt: task.prompt,
    session_id: task.session_id ?? undefined,
    enabled: task.enabled,
  })
  const [error, setError] = useState<string | null>(null)

  const updateMutation = useUpdateScheduledTaskMutation()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const mode: ScheduledTaskMode = formData.mode ?? 'normal'
    const workspace = formData.workspace ?? null

    if (mode === 'coding' && !workspace?.trim()) {
      setError('Workspace is required for coding mode'); return
    }
    if (!formData.prompt.trim()) { setError('Prompt is required'); return }
    if (formData.schedule_type === 'at' && !formData.at_datetime) {
      setError('Date/time is required for "at" schedule'); return
    }
    if (formData.schedule_type === 'every' && (!formData.every_seconds || formData.every_seconds <= 0)) {
      setError('Interval must be greater than 0'); return
    }
    if (formData.schedule_type === 'cron' && !formData.cron_expression?.trim()) {
      setError('Cron expression is required'); return
    }

    // Same naive-wall-clock → tz-aware ISO conversion as CreateTaskForm.
    const tz = formData.timezone || localTz
    const atIso = formData.at_datetime ? wallClockToISO(formData.at_datetime, tz) : undefined
    const payload: Partial<ScheduledTaskCreate> = {
      mode,
      workspace: mode === 'coding' ? workspace!.trim() : null,
      schedule_type: formData.schedule_type,
      timezone: tz,
      prompt: formData.prompt.trim(),
      session_id: formData.session_id,
      enabled: formData.enabled,
      ...(formData.schedule_type === 'at'    ? { at_datetime: atIso }                          : {}),
      ...(formData.schedule_type === 'every' ? { every_seconds: formData.every_seconds }       : {}),
      ...(formData.schedule_type === 'cron'  ? { cron_expression: formData.cron_expression }   : {}),
    }

    updateMutation.mutate({ id: task.id, body: payload }, {
      onSuccess,
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to update task')
      },
    })
  }

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-(--color-border) px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Pencil size={18} className="text-(--color-accent)" />
            <h2 className="text-base font-semibold text-(--color-text)">Edit Task</h2>
          </div>
          <button
            onClick={onCancel}
            className="rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
            aria-label="Cancel edit"
            title="Cancel"
          >
            <X size={16} />
          </button>
        </div>
        <p className="mt-1 text-sm text-(--color-text-muted)">{task.name}</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          {/* Routing — mode + workspace */}
          <ModeWorkspaceFields
            mode={formData.mode ?? 'normal'}
            workspace={formData.workspace ?? null}
            onChange={(next) =>
              setFormData((prev) => ({
                ...prev,
                mode: next.mode,
                workspace: next.workspace,
              }))
            }
          />

          {/* Schedule Type */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Schedule Type</label>
            <ScheduleTypeSegmented
              value={formData.schedule_type}
              onChange={(v) => setFormData({ ...formData, schedule_type: v })}
            />
          </div>

          {/* Schedule value (conditional) */}
          {formData.schedule_type === 'at' && (
            <div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-(--color-text)">Date & Time</label>
                  <div className="mt-1">
                    <DateTimePicker
                      value={formData.at_datetime ?? ''}
                      onChange={(v) => setFormData({ ...formData, at_datetime: v })}
                      triggerClassName="bg-(--bg-page) hover:bg-(--bg-page)"
                    />
                  </div>
                </div>
                <div className="w-44 shrink-0">
                  <label className="block text-sm font-medium text-(--color-text)">Timezone</label>
                  <Input
                    className={`mt-1 ${FIELD_CLASS}`}
                    value={formData.timezone}
                    onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                    placeholder={localTz}
                  />
                </div>
              </div>
              <p className="mt-1 text-xs text-(--color-text-muted)">IANA timezone (e.g., America/New_York)</p>
            </div>
          )}

          {formData.schedule_type === 'every' && (
            <div>
              <label className="block text-sm font-medium text-(--color-text)">Interval (seconds)</label>
              <Input
                // Numeric value rarely exceeds 6 digits — constrain to ~9rem
                // so the input does not stretch across the full form width.
                className={`mt-1 w-36 ${FIELD_CLASS}`}
                type="number"
                min="1"
                value={formData.every_seconds ?? 3600}
                onChange={(e) =>
                  setFormData({ ...formData, every_seconds: parseInt(e.target.value) || 0 })
                }
              />
              <p className="mt-1 text-xs text-(--color-text-muted)">e.g., 3600 = 1 hour, 86400 = 1 day</p>
            </div>
          )}

          {formData.schedule_type === 'cron' && (
            <div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-(--color-text)">Cron Expression</label>
                  <Input
                    className={`mt-1 ${FIELD_CLASS}`}
                    value={formData.cron_expression ?? ''}
                    onChange={(e) => setFormData({ ...formData, cron_expression: e.target.value })}
                    placeholder="e.g., 0 9 * * MON-FRI"
                  />
                </div>
                <div className="w-44 shrink-0">
                  <label className="block text-sm font-medium text-(--color-text)">Timezone</label>
                  <Input
                    className={`mt-1 ${FIELD_CLASS}`}
                    value={formData.timezone}
                    onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                    placeholder={localTz}
                  />
                </div>
              </div>
              <p className="mt-1 text-xs text-(--color-text-muted)">IANA timezone (e.g., America/New_York)</p>
            </div>
          )}

          {/* Prompt */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Prompt</label>
            <Textarea
              className={`mt-1 ${FIELD_CLASS}`}
              value={formData.prompt}
              onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
              placeholder="Message to deliver to the team lead when the task fires."
              rows={4}
            />
          </div>

          {/* Session ID */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Session ID (optional)</label>
            <Input
              className={`mt-1 ${FIELD_CLASS}`}
              value={formData.session_id ?? ''}
              onChange={(e) => setFormData({ ...formData, session_id: e.target.value || undefined })}
              placeholder="Leave blank for new session, or enter 'auto'"
            />
            <p className="mt-1 text-xs text-(--color-text-muted)">
              null = new session each run, "auto" = persistent session, or UUID
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div className="flex gap-2 rounded-lg border border-(--color-error) bg-(--color-error-subtle) p-3">
              <AlertCircle size={16} className="shrink-0 text-(--color-error)" />
              <p className="text-sm text-(--color-error)">{error}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={onCancel}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={updateMutation.isPending}
            className="flex-1"
          >
            {updateMutation.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Saving…
              </>
            ) : (
              'Save Changes'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
