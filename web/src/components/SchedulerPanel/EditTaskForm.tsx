import { useState, useEffect } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { AlertCircle, Loader2, Pencil, X } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateScheduledTaskMutation } from '@/queries'
import type { ScheduledTaskResponse } from '@/api/types'

import { FIELD_CLASS } from './utils'
import { editTaskDefaults, toUpdatePayload, validateTaskValues, type TaskFormErrors } from './taskForm'
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
  const currentSessionId = useTeamStore((state) => state.sessionId)
  const currentSessionTitle = useTeamStore((state) => state.sessionTitle)
  const activeSessionWorkspace = useTeamStore((state) => state._workspace)

  const defaults = editTaskDefaults(task, currentSessionId)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<TaskFormErrors>({})
  const validationSummary = Object.values(fieldErrors)[0]
  const updateMutation = useUpdateScheduledTaskMutation()
  const form = useForm({ defaultValues: defaults, onSubmit: () => {} })
  const values = useStore(form.store, (state) => state.values)
  const activeSessionMode = activeSessionWorkspace ? 'coding' : 'normal'
  const isSessionCompatible = !!currentSessionId && values.mode === activeSessionMode && (values.mode !== 'coding' || values.workspace === activeSessionWorkspace)

  useEffect(() => {
    if (!isSessionCompatible && values.sessionType === 'current') form.setFieldValue('sessionType', 'new')
  }, [form, isSessionCompatible, values.sessionType])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    const submitValues = form.state.values
    const errors = validateTaskValues(submitValues, false)
    if (Object.keys(errors).length) {
      setFieldErrors(errors)
      return
    }
    updateMutation.mutate(
      { slug: task.slug, body: toUpdatePayload(submitValues, localTz, currentSessionId) },
      { onSuccess, onError: (err) => setError(err instanceof Error ? err.message : 'Failed to update task') },
    )
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
            className="flex h-11 w-11 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) md:h-7 md:w-7"
            aria-label="Cancel edit"
            title="Cancel"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-1 text-sm text-(--color-text-muted)">{task.name}</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-5">
        <div className="space-y-4">
          {/* Routing — mode + workspace */}
          <ModeWorkspaceFields
            mode={values.mode ?? 'normal'}
            workspace={values.workspace ?? null}
            onChange={(next) => {
              form.setFieldValue('mode', next.mode)
              form.setFieldValue('workspace', next.workspace)
            }}
            workspaceError={fieldErrors.workspace}
            workspaceErrorId="edit-task-workspace-error"
          />

          {/* Schedule Type & Detail */}
          {values.schedule_type === 'every' ? (
            <div>
              <div className="flex flex-wrap items-start gap-4">
                <div className="shrink-0">
                  <label className="block text-sm font-medium text-(--color-text)">Schedule Type</label>
                  <div className="mt-1">
                    <ScheduleTypeSegmented
                      value={values.schedule_type}
                      onChange={(v) => form.setFieldValue('schedule_type', v)}
                    />
                  </div>
                </div>
                <div className="w-full sm:w-56 sm:shrink-0">
                  <label htmlFor="edit-task-every-seconds" className="block text-sm font-medium text-(--color-text)">Interval (seconds)</label>
                  <Input
                    id="edit-task-every-seconds"
                    className={`mt-1 w-full ${FIELD_CLASS}`}
                    type="number"
                    min="1"
                    value={values.every_seconds ?? 3600}
                    onChange={(e) =>
                      form.setFieldValue('every_seconds', parseInt(e.target.value) || 0)
                    }
                    aria-invalid={!!fieldErrors.every_seconds}
                    aria-describedby={fieldErrors.every_seconds ? 'edit-task-every-seconds-error' : 'edit-task-every-seconds-help'}
                  />
                  {fieldErrors.every_seconds && <p id="edit-task-every-seconds-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.every_seconds}</p>}
                  <p id="edit-task-every-seconds-help" className="mt-1 text-xs text-(--color-text-muted)">e.g., 3600 = 1 hour, 86400 = 1 day</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-(--color-text)">Schedule Type</label>
                <div className="mt-1">
                  <ScheduleTypeSegmented
                    value={values.schedule_type}
                    onChange={(v) => form.setFieldValue('schedule_type', v)}
                  />
                </div>
              </div>

              {values.schedule_type === 'at' && (
                <div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
                    <div className="flex-1">
                      <label htmlFor="edit-task-at-datetime" className="block text-sm font-medium text-(--color-text)">Date & Time</label>
                      <div className="mt-1">
                        <DateTimePicker
                          id="edit-task-at-datetime"
                          value={values.at_datetime ?? ''}
                          onChange={(v) => form.setFieldValue('at_datetime', v)}
                          triggerClassName="h-8 rounded-sm bg-(--bg-card) px-2 text-xs hover:bg-(--bg-key)/30"
                          aria-invalid={!!fieldErrors.at_datetime}
                          aria-describedby={fieldErrors.at_datetime ? 'edit-task-at-datetime-error' : undefined}
                        />
                      </div>
                      {fieldErrors.at_datetime && <p id="edit-task-at-datetime-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.at_datetime}</p>}
                    </div>
                    <div className="w-full min-w-0">
                      <label htmlFor="edit-task-timezone" className="block text-sm font-medium text-(--color-text)">Timezone</label>
                      <Input
                        id="edit-task-timezone"
                        className={`mt-1 ${FIELD_CLASS}`}
                        value={values.timezone}
                        onChange={(e) => form.setFieldValue('timezone', e.target.value)}
                        placeholder={localTz}
                      />
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-(--color-text-muted)">IANA timezone (e.g., America/New_York)</p>
                </div>
              )}

              {values.schedule_type === 'cron' && (
                <div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
                    <div className="flex-1">
                      <label htmlFor="edit-task-cron-expression" className="block text-sm font-medium text-(--color-text)">Cron Expression</label>
                      <Input
                        id="edit-task-cron-expression"
                        className={`mt-1 ${FIELD_CLASS}`}
                        value={values.cron_expression ?? ''}
                        onChange={(e) => form.setFieldValue('cron_expression', e.target.value)}
                        placeholder="e.g., 0 9 * * MON-FRI"
                        aria-invalid={!!fieldErrors.cron_expression}
                        aria-describedby={fieldErrors.cron_expression ? 'edit-task-cron-expression-error' : undefined}
                      />
                      {fieldErrors.cron_expression && <p id="edit-task-cron-expression-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.cron_expression}</p>}
                    </div>
                    <div className="w-full min-w-0">
                      <label htmlFor="edit-task-timezone" className="block text-sm font-medium text-(--color-text)">Timezone</label>
                      <Input
                        id="edit-task-timezone"
                        className={`mt-1 ${FIELD_CLASS}`}
                        value={values.timezone}
                        onChange={(e) => form.setFieldValue('timezone', e.target.value)}
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
            <label htmlFor="edit-task-prompt" className="block text-sm font-medium text-(--color-text)">Prompt</label>
            <Textarea
              id="edit-task-prompt"
              className={`mt-1 ${FIELD_CLASS}`}
              value={values.prompt}
              onChange={(e) => form.setFieldValue('prompt', e.target.value)}
              placeholder="Message to deliver to the team lead when the task fires."
              rows={4}
              aria-invalid={!!fieldErrors.prompt}
              aria-describedby={fieldErrors.prompt ? 'edit-task-prompt-error' : undefined}
            />
            {fieldErrors.prompt && <p id="edit-task-prompt-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.prompt}</p>}
          </div>

          {/* Session Target & Max Runs */}
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-full max-w-md">
              <label htmlFor="edit-session-target" className="block text-sm font-medium text-(--color-text)">Session Target</label>
              <Dropdown
                id="edit-session-target"
                value={values.sessionType}
                onValueChange={(v) => form.setFieldValue('sessionType', v as 'new' | 'auto' | 'current' | 'custom')}
                trigger="Session Target"
                className="mt-1 w-full px-2 py-1 text-[11px]"
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
                {values.sessionType === 'new' && 'Creates a fresh, isolated chat session for every run.'}
                {values.sessionType === 'auto' && 'Runs all executions in a single dedicated chat session created for this task.'}
                {values.sessionType === 'current' && 'Delivers the prompt directly into your active chat thread.'}
                {values.sessionType === 'custom' && 'Delivers the prompt to a specific chat session by its UUID.'}
              </p>

              {values.sessionType === 'custom' && (
                <div className="mt-2">
                  <label htmlFor="edit-custom-session-id" className="sr-only">Session UUID</label>
                  <Input
                    id="edit-custom-session-id"
                    className={FIELD_CLASS}
                    value={values.customSessionId}
                    onChange={(e) => form.setFieldValue('customSessionId', e.target.value)}
                    placeholder="Enter session UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)"
                    aria-invalid={!!fieldErrors.customSessionId}
                    aria-describedby={fieldErrors.customSessionId ? 'edit-custom-session-id-error' : undefined}
                  />
                  {fieldErrors.customSessionId && <p id="edit-custom-session-id-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.customSessionId}</p>}
                </div>
              )}
            </div>

            <div className="w-full min-w-0">
              <label htmlFor="edit-task-max-runs" className="block text-sm font-medium text-(--color-text)">Max runs (optional)</label>
              <Input
                id="edit-task-max-runs"
                type="number"
                min="1"
                className={`mt-1 w-full ${FIELD_CLASS}`}
                value={values.max_runs ?? ''}
                onChange={(e) => form.setFieldValue('max_runs', e.target.value ? Number(e.target.value) : null)}
                placeholder="Unlimited"
                aria-invalid={!!fieldErrors.max_runs}
                aria-describedby={fieldErrors.max_runs ? 'edit-task-max-runs-error' : 'edit-task-max-runs-help'}
              />
              {fieldErrors.max_runs && <p id="edit-task-max-runs-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.max_runs}</p>}
              <p id="edit-task-max-runs-help" className="mt-1 text-xs text-(--color-text-muted)">Stop after this many successful firings.</p>
            </div>
          </div>

          {/* Error message */}
          {validationSummary && <p role="alert" className="sr-only">Please correct the highlighted fields.</p>}
          {error && (
            <div role="alert" className="flex gap-2 rounded-sm border border-(--color-error) bg-(--color-error-subtle) p-3">
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
            size="sm"
            className="sm:min-w-20"
            onClick={onCancel}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={updateMutation.isPending}
            className="sm:min-w-28"
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
