import { useState, type ReactNode } from 'react'
import { CalendarClock, Check, Copy, FolderOpen, Loader2, Pause, Pencil, Play, Terminal, Trash2, X, Zap } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { formatRelativeDate, formatInTimezone } from '@/utils/format'
import { formatScheduleLabel, slugify } from './utils'
import { EditTaskForm } from './EditTaskForm'
import { useAgentStore } from '@/stores/useAgentStore'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDeleteScheduledTaskMutation, usePauseScheduledTaskMutation, useResumeScheduledTaskMutation, useTriggerScheduledTaskMutation } from '@/queries'
import { SchedulerBackButton, useSchedulerPaneHeaderClass } from './chrome'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { COMPACT_ROW, ICON_SIZE, ICON_SIZE_INLINE, TEXT } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'

export function TaskDetailView({
  task,
  onClose,
  closeMode = 'close',
}: {
  task: ScheduledTaskResponse
  onClose: () => void
  /**
   * ``back`` swaps the trailing close button for a leading back arrow, for
   * stacked hosts (the dock) where the detail replaces the list.
   */
  closeMode?: 'close' | 'back'
}) {
  const [editing, setEditing] = useState(false)
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const currentSessionId = useAgentStore((state) => state.sessionId)
  const headerClass = useSchedulerPaneHeaderClass()

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

  const sessionLabel = !task.session_id
    ? 'New session for each run'
    : task.session_id === 'auto'
      ? 'One persistent session, reused every run'
      : task.session_id === currentSessionId
        ? 'This chat session'
        : null

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-(--bg-page)">
      {/* Header */}
      <div className={headerClass}>
        <div className="flex items-start justify-between gap-3">
          {closeMode === 'back' && <SchedulerBackButton onClick={onClose} />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold tracking-tight text-(--color-text)">{task.name}</h2>
              <span className="rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/60 px-1.5 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-subtle)">
                slug: <span className="text-(--color-text-2)">{slugify(task.name)}</span>
              </span>
            </div>
            <div className={cn('mt-1 flex items-center gap-1.5', TEXT.hint)}>
              <CalendarClock size={12} className="shrink-0" aria-hidden="true" />
              <span>{formatScheduleLabel(task)}</span>
            </div>
          </div>
          <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">
            <HeaderAction
              label="Trigger now"
              onClick={triggerTask}
              disabled={triggerMutation.isPending}
              icon={triggerMutation.isPending ? <Loader2 size={ICON_SIZE} className="animate-spin" /> : <Zap size={ICON_SIZE} />}
            />
            <HeaderAction
              label={task.status === 'paused' ? 'Resume' : 'Pause'}
              onClick={togglePaused}
              disabled={pauseMutation.isPending || resumeMutation.isPending}
              icon={
                pauseMutation.isPending || resumeMutation.isPending ? (
                  <Loader2 size={ICON_SIZE} className="animate-spin" />
                ) : task.status === 'paused' ? (
                  <Play size={ICON_SIZE} />
                ) : (
                  <Pause size={ICON_SIZE} />
                )
              }
            />
            <HeaderAction label="Edit task" onClick={() => setEditing(true)} icon={<Pencil size={ICON_SIZE} />} />
            <HeaderAction
              label="Delete task"
              danger
              onClick={() => setDeleteConfirmationOpen(true)}
              disabled={deleteMutation.isPending}
              icon={<Trash2 size={ICON_SIZE} />}
            />
            {closeMode === 'close' && (
              <HeaderAction label="Close detail" tooltip="Close" onClick={onClose} icon={<X size={ICON_SIZE} />} />
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 space-y-8 overflow-y-auto overscroll-contain touch-pan-y px-4 py-5 @xl:px-6 @xl:py-6">
        {/* Status strip */}
        <section aria-label="Status" className="grid grid-cols-3 gap-3">
          <StatTile label="Status">
            <span className="flex items-center gap-1.5">
              <span className={`size-2 shrink-0 rounded-full ${statusDotColor}`} aria-hidden="true" />
              <span className={`capitalize ${statusColor}`}>{task.status}</span>
            </span>
          </StatTile>
          <StatTile label="Enabled">{task.enabled ? 'Yes' : 'No'}</StatTile>
          <StatTile label="Runs">
            {task.run_count}{task.max_runs ? ` / ${task.max_runs}` : ''}
          </StatTile>
        </section>

        <PanelSection title="Delivery" flush>
          <DetailRow label="Agent">
            {task.workspace ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <FolderOpen size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                <span className="shrink-0">Coding agent</span>
                <Tooltip className="min-w-0 max-w-[220px]">
                  <TooltipTrigger
                    className="min-w-0 max-w-[220px]"
                    render={<span className="truncate font-mono text-(--color-text-muted)">· {task.workspace}</span>}
                  />
                  <TooltipContent>{task.workspace}</TooltipContent>
                </Tooltip>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Terminal size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                Default agent
              </span>
            )}
          </DetailRow>
          <DetailRow label="Session">
            {sessionLabel ?? (
              <span className="break-all font-mono text-(--color-text-2)">{task.session_id}</span>
            )}
          </DetailRow>
        </PanelSection>

        <PanelSection title="Schedule" flush>
          <DetailRow label="Type">
            <span className="capitalize">{task.schedule_type}</span>
          </DetailRow>
          {task.schedule_type === 'at' && task.at_datetime && (
            <DetailRow label="Date and time">{formatInTimezone(task.at_datetime, task.timezone)}</DetailRow>
          )}
          {task.schedule_type === 'every' && task.every_seconds && (
            <DetailRow label="Interval">{task.every_seconds}s</DetailRow>
          )}
          {task.schedule_type === 'cron' && task.cron_expression && (
            <DetailRow label="Expression">
              <code className="rounded-xs bg-(--bg-key) px-1.5 py-0.5 font-mono text-xs text-(--color-text)">
                {task.cron_expression}
              </code>
            </DetailRow>
          )}
          <DetailRow label="Timezone">{task.timezone}</DetailRow>
        </PanelSection>

        <PanelSection
          title="Prompt"
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={handleCopyPrompt} aria-label="Copy prompt">
              {copiedPrompt ? (
                <Check size={ICON_SIZE_INLINE} className="text-(--color-success)" aria-hidden="true" />
              ) : (
                <Copy size={ICON_SIZE_INLINE} aria-hidden="true" />
              )}
              {copiedPrompt ? 'Copied' : 'Copy'}
            </Button>
          }
        >
          <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-text)">
            {task.prompt}
          </p>
        </PanelSection>

        <section className="space-y-3">
          <PanelSection title="Runs" flush>
            {task.last_run_at && (
              <DetailRow label="Last run">{formatRelativeDate(task.last_run_at)}</DetailRow>
            )}
            {task.next_fire_at && (
              <DetailRow label="Next run">
                <span className="font-medium text-(--color-accent)">{formatRelativeDate(task.next_fire_at)}</span>
              </DetailRow>
            )}
            <DetailRow label="Created">{formatRelativeDate(task.created_at)}</DetailRow>
            <DetailRow label="Updated">{formatRelativeDate(task.updated_at)}</DetailRow>
          </PanelSection>
          {task.last_error && (
            <Callout tone="error" title="Last run failed">
              <p className="whitespace-pre-wrap break-words font-mono">{task.last_error}</p>
            </Callout>
          )}
        </section>
      </div>

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
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={cn(COMPACT_ROW, 'justify-between')}>
      <span className={cn('shrink-0', TEXT.hint)}>{label}</span>
      <span className={cn('min-w-0 text-right', TEXT.label)}>{children}</span>
    </div>
  )
}

function StatTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-3.5">
      <p className={TEXT.hint}>{label}</p>
      <div className="mt-1 text-sm font-semibold text-(--color-text)">{children}</div>
    </div>
  )
}

function HeaderAction({
  label,
  tooltip = label,
  icon,
  onClick,
  disabled,
  danger = false,
}: {
  label: string
  tooltip?: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={cn(
              'text-(--color-text-muted) pointer-coarse:size-9',
              danger ? 'hover:bg-(--color-error-subtle) hover:text-(--color-error)' : 'hover:text-(--color-text)',
            )}
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
