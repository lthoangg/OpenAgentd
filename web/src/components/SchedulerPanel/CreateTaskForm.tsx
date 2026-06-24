import { useState } from 'react'
import { AlertCircle, Loader2, Plus } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCreateScheduledTaskMutation } from '@/queries'
import type { ScheduledTaskCreate, ScheduledTaskMode } from '@/api/types'
import { wallClockToISO } from '@/utils/format'
import { FIELD_CLASS } from './utils'
import { ScheduleTypeSegmented } from './ScheduleTypeSegmented'
import { ModeWorkspaceFields } from './ModeWorkspaceFields'

export function CreateTaskForm({
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
    max_runs: null,
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
      max_runs: formData.max_runs ?? null,
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
          max_runs: null,
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

          {/* Max runs */}
          <div>
            <label className="block text-sm font-medium text-(--color-text)">Max runs (optional)</label>
            <Input
              type="number"
              min="1"
              className={`mt-1 ${FIELD_CLASS}`}
              value={formData.max_runs ?? ''}
              onChange={(e) => setFormData({ ...formData, max_runs: e.target.value ? Number(e.target.value) : null })}
              placeholder="Unlimited"
            />
            <p className="mt-1 text-xs text-(--color-text-muted)">Stop after this many successful firings.</p>
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
