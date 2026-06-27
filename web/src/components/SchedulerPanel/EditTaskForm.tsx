import { useState, useEffect } from 'react'
import { AlertCircle, Loader2, Pencil, X } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateScheduledTaskMutation } from '@/queries'
import type { ScheduledTaskResponse, ScheduledTaskCreate, ScheduledTaskMode } from '@/api/types'
import { isoToWallClock, wallClockToISO } from '@/utils/format'
import { FIELD_CLASS } from './utils'
import { ScheduleTypeSegmented } from './ScheduleTypeSegmented'
import { ModeWorkspaceFields } from './ModeWorkspaceFields'
import { useTeamStore } from '@/stores/useTeamStore'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'

export function EditTaskForm({
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
    max_runs: task.max_runs ?? null,
    enabled: task.enabled,
  })
  const [error, setError] = useState<string | null>(null)

  const currentSessionId = useTeamStore((state) => state.sessionId)
  const currentSessionTitle = useTeamStore((state) => state.sessionTitle)
  const activeSessionWorkspace = useTeamStore((state) => state._workspace)

  const activeSessionMode = activeSessionWorkspace ? 'coding' : 'normal'
  const isSessionCompatible =
    !!currentSessionId &&
    formData.mode === activeSessionMode &&
    (formData.mode !== 'coding' || formData.workspace === activeSessionWorkspace)

  const getInitialSessionType = (
    sid: string | null | undefined,
    currSid: string | null
  ): 'new' | 'auto' | 'current' | 'custom' => {
    if (!sid) return 'new'
    if (sid === 'auto') return 'auto'
    if (currSid && sid === currSid) return 'current'
    return 'custom'
  }

  const [sessionType, setSessionType] = useState<'new' | 'auto' | 'current' | 'custom'>(
    getInitialSessionType(task.session_id, currentSessionId)
  )
  const [customSessionId, setCustomSessionId] = useState(
    getInitialSessionType(task.session_id, currentSessionId) === 'custom' ? (task.session_id ?? '') : ''
  )

  useEffect(() => {
    if (!isSessionCompatible && sessionType === 'current') {
      setSessionType('new')
    }
  }, [isSessionCompatible, sessionType])

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

    if (sessionType === 'custom') {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!customSessionId.trim()) {
        setError('Session UUID is required'); return
      }
      if (!uuidRegex.test(customSessionId.trim())) {
        setError('Please enter a valid UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)'); return
      }
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
      session_id:
        sessionType === 'new'
          ? null
          : sessionType === 'auto'
          ? 'auto'
          : sessionType === 'current'
          ? currentSessionId
          : customSessionId.trim() || null,
      max_runs: formData.max_runs ?? null,
      enabled: formData.enabled,
      ...(formData.schedule_type === 'at'    ? { at_datetime: atIso }                          : {}),
      ...(formData.schedule_type === 'every' ? { every_seconds: formData.every_seconds }       : {}),
      ...(formData.schedule_type === 'cron'  ? { cron_expression: formData.cron_expression }   : {}),
    }

    updateMutation.mutate({ slug: task.slug, body: payload }, {
      onSuccess,
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to update task')
      },
    })
  }

  return (
    <div className="flex flex-col overflow-hidden bg-(--bg-page)">
      {/* Header */}
      <div className="border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-3 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Pencil size={18} className="text-(--color-accent)" />
            <h2 className="text-base font-semibold text-(--color-text)">Edit Task</h2>
          </div>
          <button
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
            aria-label="Cancel edit"
            title="Cancel"
          >
            <X size={16} />
          </button>
        </div>
        <p className="mt-1 text-sm text-(--color-text-muted)">{task.name}</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-5">
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

          {/* Schedule Type & Detail */}
          {formData.schedule_type === 'every' ? (
            <div>
              <div className="flex flex-wrap items-start gap-4">
                <div className="shrink-0">
                  <label className="block text-sm font-medium text-(--color-text)">Schedule Type</label>
                  <div className="mt-1">
                    <ScheduleTypeSegmented
                      value={formData.schedule_type}
                      onChange={(v) => setFormData({ ...formData, schedule_type: v })}
                    />
                  </div>
                </div>
                <div className="w-full sm:w-56 sm:shrink-0">
                  <label className="block text-sm font-medium text-(--color-text)">Interval (seconds)</label>
                  <Input
                    className={`mt-1 w-full ${FIELD_CLASS}`}
                    type="number"
                    min="1"
                    value={formData.every_seconds ?? 3600}
                    onChange={(e) =>
                      setFormData({ ...formData, every_seconds: parseInt(e.target.value) || 0 })
                    }
                  />
                  <p className="mt-1 text-xs text-(--color-text-muted)">e.g., 3600 = 1 hour, 86400 = 1 day</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-(--color-text)">Schedule Type</label>
                <div className="mt-1">
                  <ScheduleTypeSegmented
                    value={formData.schedule_type}
                    onChange={(v) => setFormData({ ...formData, schedule_type: v })}
                  />
                </div>
              </div>

              {formData.schedule_type === 'at' && (
                <div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
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
                    <div className="w-full min-w-0">
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

              {formData.schedule_type === 'cron' && (
                <div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-(--color-text)">Cron Expression</label>
                      <Input
                        className={`mt-1 ${FIELD_CLASS}`}
                        value={formData.cron_expression ?? ''}
                        onChange={(e) => setFormData({ ...formData, cron_expression: e.target.value })}
                        placeholder="e.g., 0 9 * * MON-FRI"
                      />
                    </div>
                    <div className="w-full min-w-0">
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
            </>
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

          {/* Session Target & Max Runs */}
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-full max-w-md">
              <label htmlFor="edit-session-target" className="block text-sm font-medium text-(--color-text)">Session Target</label>
              <Dropdown
                value={sessionType}
                onValueChange={(v) => setSessionType(v as 'new' | 'auto' | 'current' | 'custom')}
                trigger="Session Target"
                className="mt-1 w-full"
              >
                <DropdownItem value="new">New Session</DropdownItem>
                <DropdownItem value="auto">Persistent Task Session</DropdownItem>
                {isSessionCompatible && (
                  <DropdownItem value="current">
                    Current Chat Session ({currentSessionTitle ? `"${currentSessionTitle}"` : 'Active'})
                  </DropdownItem>
                )}
                <DropdownItem value="custom">Specific Session ID…</DropdownItem>
              </Dropdown>
              <p className="mt-1 text-xs text-(--color-text-muted)">
                {sessionType === 'new' && 'Creates a fresh, isolated chat session for every run.'}
                {sessionType === 'auto' && 'Runs all executions in a single dedicated chat session created for this task.'}
                {sessionType === 'current' && 'Delivers the prompt directly into your active chat thread.'}
                {sessionType === 'custom' && 'Delivers the prompt to a specific chat session by its UUID.'}
              </p>

              {sessionType === 'custom' && (
                <div className="mt-2">
                  <Input
                    className={FIELD_CLASS}
                    value={customSessionId}
                    onChange={(e) => setCustomSessionId(e.target.value)}
                    placeholder="Enter session UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)"
                  />
                </div>
              )}
            </div>

            <div className="w-full min-w-0">
              <label className="block text-sm font-medium text-(--color-text)">Max runs (optional)</label>
              <Input
                type="number"
                min="1"
                className={`mt-1 w-full ${FIELD_CLASS}`}
                value={formData.max_runs ?? ''}
                onChange={(e) => setFormData({ ...formData, max_runs: e.target.value ? Number(e.target.value) : null })}
                placeholder="Unlimited"
              />
              <p className="mt-1 text-xs text-(--color-text-muted)">Stop after this many successful firings.</p>
            </div>
          </div>

          {/* Error message */}
          {error && (
            <div className="flex gap-2 rounded-sm border border-(--color-error) bg-(--color-error-subtle) p-3">
              <AlertCircle size={16} className="shrink-0 text-(--color-error)" />
              <p className="text-sm text-(--color-error)">{error}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="subtle"
            className="sm:min-w-24"
            onClick={onCancel}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={updateMutation.isPending}
            className="sm:min-w-32"
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
