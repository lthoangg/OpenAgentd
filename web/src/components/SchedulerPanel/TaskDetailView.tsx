import { useState, type ReactNode } from 'react'
import { AlertCircle, CalendarClock, Check, Copy, FolderOpen, Loader2, Pause, Pencil, Play, Terminal, Trash2, X, Zap } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { formatRelativeDate, formatInTimezone } from '@/utils/format'
import { formatScheduleLabel, slugify } from './utils'
import { EditTaskForm } from './EditTaskForm'
import { useTeamStore } from '@/stores/useTeamStore'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDeleteScheduledTaskMutation, usePauseScheduledTaskMutation, useResumeScheduledTaskMutation, useTriggerScheduledTaskMutation } from '@/queries'

export function TaskDetailView({
  task,
  onClose,
}: {
  task: ScheduledTaskResponse
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const currentSessionId = useTeamStore((state) => state.sessionId)

  const deleteMutation = useDeleteScheduledTaskMutation()
  const pauseMutation = usePauseScheduledTaskMutation()
  const resumeMutation = useResumeScheduledTaskMutation()
  const triggerMutation = useTriggerScheduledTaskMutation()

  const triggerTask = () => triggerMutation.mutate(task.slug)
  const togglePaused = () => {
    if (task.status === 'paused') resumeMutation.mutate(task.slug)
    else pauseMutation.mutate(task.slug)
  }
  const deleteTask = () => {
    deleteMutation.mutate(task.slug, {
      onSuccess: () => {
        setDeleteConfirmationOpen(false)
        onClose()
      },
    })
  }

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(task.prompt)
      setCopiedPrompt(true)
      setTimeout(() => setCopiedPrompt(false), 2000)
    } catch {
      // ignore
    }
  }

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

  const statusDotColor = {
    pending: 'bg-(--color-text-muted)',
    running: 'bg-(--color-info) animate-pulse',
    paused: 'bg-(--color-warning)',
    completed: 'bg-(--color-success)',
    failed: 'bg-(--color-error)',
  }[task.status] ?? 'bg-(--color-text-muted)'

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-(--bg-page)">
      {/* Header */}
      <div className="border-b border-(--color-border) bg-(--bg-sidebar) px-4 py-2.5 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-bold text-(--color-text)">{task.name}</h2>
              <span className="rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/60 px-1.5 py-0.5 font-mono text-[10.5px] text-(--color-text-subtle)">
                slug: <span className="text-(--color-text-2)">{slugify(task.name)}</span>
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-(--color-text-muted)">
              <CalendarClock size={12} className="text-(--color-text-subtle)" />
              <span>{formatScheduleLabel(task)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={triggerTask}
                    disabled={triggerMutation.isPending}
                    aria-label="Trigger now"
                    className="h-7 w-7 rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-accent)"
                  >
                    {triggerMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
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
                    onClick={togglePaused}
                    disabled={pauseMutation.isPending || resumeMutation.isPending}
                    aria-label={task.status === 'paused' ? 'Resume' : 'Pause'}
                    className="h-7 w-7 rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
                  >
                    {pauseMutation.isPending || resumeMutation.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : task.status === 'paused' ? (
                      <Play size={13} />
                    ) : (
                      <Pause size={13} />
                    )}
                  </Button>
                }
              />
              <TooltipContent>{task.status === 'paused' ? 'Resume' : 'Pause'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    onClick={() => setEditing(true)}
                    className="flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                    aria-label="Edit task"
                  >
                    <Pencil size={13} />
                  </button>
                }
              />
              <TooltipContent>Edit task</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setDeleteConfirmationOpen(true)}
                    disabled={deleteMutation.isPending}
                    aria-label="Delete task"
                    className="h-7 w-7 rounded-sm text-(--color-text-muted) hover:bg-(--color-error-subtle) hover:text-(--color-error)"
                  >
                    <Trash2 size={13} />
                  </Button>
                }
              />
              <TooltipContent>Delete task</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    onClick={onClose}
                    className="flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                    aria-label="Close detail"
                  >
                    <X size={14} />
                  </button>
                }
              />
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
        {/* Status Metrics Strip */}
        <section className="grid grid-cols-3 gap-2">
          <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-2.5">
            <span className="text-[10.5px] font-medium text-(--color-text-muted)">Status</span>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor}`} aria-hidden="true" />
              <span className={`text-xs font-semibold capitalize ${statusColor}`}>{task.status}</span>
            </div>
          </div>
          <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-2.5">
            <span className="text-[10.5px] font-medium text-(--color-text-muted)">Enabled</span>
            <div className="mt-0.5 text-xs font-semibold text-(--color-text)">
              {task.enabled ? 'Yes' : 'No'}
            </div>
          </div>
          <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-2.5">
            <span className="text-[10.5px] font-medium text-(--color-text-muted)">Run Count</span>
            <div className="mt-0.5 text-xs font-semibold text-(--color-text)">
              {task.run_count}{task.max_runs ? ` / ${task.max_runs}` : ''}
            </div>
          </div>
        </section>

        {/* Configuration Card */}
        <section className="rounded-sm border border-(--color-border) bg-(--bg-card) p-3">
          <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Routing & Target
          </h3>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-xs border border-(--color-border-subtle) bg-(--bg-page) p-2.5">
              <span className="text-[10.5px] font-medium text-(--color-text-muted)">Routing</span>
              <p className="mt-0.5 text-xs font-medium text-(--color-text)">
                {task.workspace ? (
                  <span className="inline-flex items-center gap-1.5">
                    <FolderOpen size={12} className="text-(--color-accent)" />
                    <span>Coding team</span>
                    {task.workspace && (
                      <Tooltip className="min-w-0 max-w-[200px]">
                        <TooltipTrigger
                          className="min-w-0 max-w-[200px]"
                          render={<span className="font-mono text-xs text-(--color-text-muted) truncate">· {task.workspace}</span>}
                        />
                        <TooltipContent>{task.workspace}</TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Terminal size={12} className="text-(--color-accent)" />
                    <span>Default team lead</span>
                  </span>
                )}
              </p>
            </div>

            <div className="rounded-xs border border-(--color-border-subtle) bg-(--bg-page) p-2.5">
              <span className="text-[10.5px] font-medium text-(--color-text-muted)">Session Target</span>
              <p className="mt-0.5 text-xs text-(--color-text)">
                {!task.session_id && 'New Session (fresh thread each run)'}
                {task.session_id === 'auto' && 'Persistent Session (reused dedicated thread)'}
                {task.session_id && task.session_id !== 'auto' && (
                  <>
                    {task.session_id === currentSessionId ? (
                      <span className="font-semibold text-(--color-accent)">
                        Current Chat Session (active thread)
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-(--color-text-2) break-all">
                        Specific Session: {task.session_id}
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>
        </section>

        {/* Schedule Timing Card */}
        <section className="rounded-sm border border-(--color-border) bg-(--bg-card) p-3">
          <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Schedule Details
          </h3>
          <div className="divide-y divide-(--color-border-subtle) rounded-xs border border-(--color-border-subtle) bg-(--bg-page) px-2.5">
            <DetailRow label="Type">
              <span className="text-xs font-semibold text-(--color-text) capitalize">{task.schedule_type}</span>
            </DetailRow>
            {task.schedule_type === 'at' && task.at_datetime && (
              <DetailRow label="Date/Time">
                <span className="text-xs font-medium text-(--color-text)">
                  {formatInTimezone(task.at_datetime, task.timezone)}
                </span>
              </DetailRow>
            )}
            {task.schedule_type === 'every' && task.every_seconds && (
              <DetailRow label="Interval">
                <span className="text-xs font-medium text-(--color-text)">{task.every_seconds}s</span>
              </DetailRow>
            )}
            {task.schedule_type === 'cron' && task.cron_expression && (
              <DetailRow label="Expression">
                <code className="rounded-xs bg-(--bg-key) px-1.5 py-0.5 font-mono text-xs font-medium text-(--color-text)">
                  {task.cron_expression}
                </code>
              </DetailRow>
            )}
            <DetailRow label="Timezone">
              <span className="text-xs text-(--color-text-muted)">{task.timezone}</span>
            </DetailRow>
          </div>
        </section>

        {/* Prompt Card */}
        <section className="rounded-sm border border-(--color-border) bg-(--bg-card) p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
              Prompt
            </h3>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleCopyPrompt}
                    className="h-6 gap-1 px-1.5 text-[11px] text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
                  >
                    {copiedPrompt ? <Check size={12} className="text-(--color-success)" /> : <Copy size={12} />}
                    <span>{copiedPrompt ? 'Copied' : 'Copy'}</span>
                  </Button>
                }
              />
              <TooltipContent>Copy prompt</TooltipContent>
            </Tooltip>
          </div>
          <div className="rounded-xs border border-(--color-border-subtle) bg-(--bg-page) p-2.5 font-mono text-xs leading-relaxed text-(--color-text) whitespace-pre-wrap">
            {task.prompt}
          </div>
        </section>

        {/* Run History Card */}
        <section className="rounded-sm border border-(--color-border) bg-(--bg-card) p-3">
          <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Run History
          </h3>
          <div className="divide-y divide-(--color-border-subtle) rounded-xs border border-(--color-border-subtle) bg-(--bg-page) px-2.5">
            {task.last_run_at && (
              <DetailRow label="Last Run">
                <span className="text-xs text-(--color-text)">
                  {formatRelativeDate(task.last_run_at)}
                </span>
              </DetailRow>
            )}
            {task.next_fire_at && (
              <DetailRow label="Next Fire">
                <span className="text-xs font-medium text-(--color-accent)">
                  {formatRelativeDate(task.next_fire_at)}
                </span>
              </DetailRow>
            )}
            {!task.last_run_at && !task.next_fire_at && !task.last_error && (
              <div className="py-2 text-center text-xs italic text-(--color-text-muted)">
                No runs recorded yet.
              </div>
            )}
          </div>

          {task.last_error && (
            <div className="mt-2.5 rounded-xs border border-(--color-error)/30 bg-(--color-error-subtle) p-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-(--color-error)">
                <AlertCircle size={12} />
                <span>Last Execution Error</span>
              </div>
              <p className="mt-1 font-mono text-xs text-(--color-error) whitespace-pre-wrap">
                {task.last_error}
              </p>
            </div>
          )}
        </section>

        {/* Metadata Footer */}
        <div className="px-1 py-1">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-(--color-text-subtle)">
            <div>Created: {formatRelativeDate(task.created_at)}</div>
            <div>Updated: {formatRelativeDate(task.updated_at)}</div>
          </div>
        </div>
      </div>

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
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-(--color-text-muted)">{label}</span>
      {children}
    </div>
  )
}
