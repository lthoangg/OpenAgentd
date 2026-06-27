import { useState, type ReactNode } from 'react'
import { Pencil, X } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { formatRelativeDate, formatInTimezone } from '@/utils/format'
import { formatScheduleLabel, slugify } from './utils'
import { EditTaskForm } from './EditTaskForm'
import { useTeamStore } from '@/stores/useTeamStore'

export function TaskDetailView({
  task,
  onClose,
}: {
  task: ScheduledTaskResponse
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const currentSessionId = useTeamStore((state) => state.sessionId)

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
    <div className="flex flex-col overflow-hidden bg-(--bg-page)">
      {/* Header */}
      <div className="border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-3 sm:px-5 sm:py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-(--color-text)">{task.name}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-(--color-text-muted)">
              slug: <span className="text-(--color-text-2)">{slugify(task.name)}</span>
            </p>
            <p className="mt-1 text-sm text-(--color-text-muted)">{formatScheduleLabel(task)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setEditing(true)}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
              aria-label="Edit task"
              title="Edit task"
            >
              <Pencil size={16} />
            </button>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
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
        <section className="px-3 py-4 sm:px-5">
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
              <span className="text-sm text-(--color-text)">
                {task.run_count}{task.max_runs ? ` / ${task.max_runs}` : ''}
              </span>
            </DetailRow>
          </div>
        </section>

        <section className="border-t border-(--color-border) px-3 py-4 sm:px-5">
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

        <section className="border-t border-(--color-border) px-3 py-4 sm:px-5">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
            Configuration
          </h3>
          <div className="space-y-3">
            <div>
              <span className="text-xs text-(--color-text-muted)">Routing</span>
              <p className="mt-1 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-sm text-(--color-text)">
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
              <p className="mt-1 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-sm leading-relaxed text-(--color-text) whitespace-pre-wrap">
                {task.prompt}
              </p>
            </div>
            <div>
              <span className="text-xs text-(--color-text-muted)">Session Target</span>
              <p className="mt-1 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-sm text-(--color-text)">
                {!task.session_id && 'New Session (fresh thread each run)'}
                {task.session_id === 'auto' && 'Persistent Session (reused dedicated thread)'}
                {task.session_id && task.session_id !== 'auto' && (
                  <>
                    {task.session_id === currentSessionId ? (
                      <span className="font-medium text-(--color-accent)">
                        Current Chat Session (active thread)
                      </span>
                    ) : (
                      <span className="font-mono text-xs break-all">
                        Specific Session: {task.session_id}
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-(--color-border) px-3 py-4 sm:px-5">
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
                <p className="mt-1 rounded-sm border border-(--color-error) bg-(--color-error-subtle) px-3 py-2 text-xs text-(--color-error) whitespace-pre-wrap">
                  {task.last_error}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="border-t border-(--color-border) px-3 py-3 sm:px-5">
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
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-(--color-text-muted)">{label}</span>
      {children}
    </div>
  )
}

// ── Edit task form ──────────────────────────────────────────────────────────
