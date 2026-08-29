import { useState, useEffect } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { AlertCircle, Loader2, Plus } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCreateScheduledTaskMutation } from '@/queries'
import { FIELD_CLASS, slugify } from './utils'
import { createTaskDefaults, toCreatePayload, validateTaskValues, type TaskFormErrors } from './taskForm'
import { ScheduleTypeSegmented } from './ScheduleTypeSegmented'
import { ModeWorkspaceFields } from './ModeWorkspaceFields'
import { useAgentStore } from '@/stores/useAgentStore'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'

export function CreateTaskForm({
  contextWorkspace,
  onSuccess,
}: {
  contextWorkspace: string | null
  onSuccess: () => void
}) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const defaults = createTaskDefaults(contextWorkspace, localTz)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<TaskFormErrors>({})
  const validationSummary = Object.values(fieldErrors)[0]

  const currentSessionId = useAgentStore((state) => state.sessionId)
  const currentSessionTitle = useAgentStore((state) => state.sessionTitle)
  const activeSessionWorkspace = useAgentStore((state) => state._workspace)

  const createMutation = useCreateScheduledTaskMutation()
  const form = useForm({
    defaultValues: defaults,
    onSubmit: () => {},
  })
  const values = useStore(form.store, (state) => state.values)
  const isSessionCompatible =
    !!currentSessionId &&
    values.workspace === activeSessionWorkspace

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    const submitValues = form.state.values
    const errors = validateTaskValues(submitValues)
    if (Object.keys(errors).length) { setFieldErrors(errors); return }
    const payload = toCreatePayload(submitValues, localTz, currentSessionId)

    createMutation.mutate(payload, {
      onSuccess: () => {
        form.reset()
        setFieldErrors({})
        onSuccess()
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to create task')
      },
    })
  }

  useEffect(() => {
    if (!isSessionCompatible && values.sessionType === 'current') {
      form.setFieldValue('sessionType', 'new')
    }
  }, [form, isSessionCompatible, values.sessionType])

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-(--bg-page)">
      {/* Header */}
      <div className="border-b border-(--color-border) bg-(--bg-sidebar) px-4 py-2.5 sm:px-5">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-sm border border-(--color-accent)/30 bg-(--color-accent)/10 text-(--color-accent)">
            <Plus size={13} />
          </div>
          <h2 className="text-sm font-bold text-(--color-text)">Create Task</h2>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto p-4 sm:p-5">
        <div className="space-y-3.5">
          {/* Title */}
          <div>
            <label htmlFor="task-title" className="mb-1 block text-xs font-medium text-(--color-text-2)">Task Title</label>
            <Input
              id="task-title"
              className={`h-8 ${FIELD_CLASS}`}
              value={values.title}
              onChange={(e) => form.setFieldValue('title', e.target.value)}
              placeholder="e.g., Daily Standup Report"
              maxLength={100}
              aria-invalid={!!fieldErrors.title}
              aria-describedby={fieldErrors.title ? 'task-title-error' : undefined}
            />
            {fieldErrors.title && <p id="task-title-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.title}</p>}
            {values.title && (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-(--color-text-muted)">
                <span>Slug identifier:</span>
                <code className="rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/80 px-1.5 py-0.5 font-mono text-[10.5px] text-(--color-text-2)">
                  {slugify(values.title)}
                </code>
              </div>
            )}
          </div>

          {/* Routing */}
          <ModeWorkspaceFields
            workspace={values.workspace ?? null}
            onChange={(workspace) => form.setFieldValue('workspace', workspace ?? '')}
            workspaceError={fieldErrors.workspace}
            workspaceErrorId="task-workspace-error"
          />

          {/* Schedule Type & Detail */}
          {values.schedule_type === 'every' ? (
            <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
              <div>
                <label className="mb-1 block text-xs font-medium text-(--color-text-2)">Schedule Type</label>
                <ScheduleTypeSegmented
                  value={values.schedule_type}
                  onChange={(v) => form.setFieldValue('schedule_type', v)}
                />
              </div>
              <div>
                <label htmlFor="task-every-seconds" className="mb-1 block text-xs font-medium text-(--color-text-2)">Interval (seconds)</label>
                <Input
                  id="task-every-seconds"
                  className={`h-8 w-full ${FIELD_CLASS}`}
                  type="number"
                  min="1"
                  value={values.every_seconds ?? 3600}
                  onChange={(e) =>
                    form.setFieldValue('every_seconds', parseInt(e.target.value) || 0)
                  }
                  aria-invalid={!!fieldErrors.every_seconds}
                  aria-describedby={fieldErrors.every_seconds ? 'task-every-seconds-error' : 'task-every-seconds-help'}
                />
                {fieldErrors.every_seconds && <p id="task-every-seconds-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.every_seconds}</p>}
                <p id="task-every-seconds-help" className="mt-1 text-xs text-(--color-text-muted)">e.g., 3600 = 1 hour, 86400 = 1 day</p>
              </div>
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-medium text-(--color-text-2)">Schedule Type</label>
              <ScheduleTypeSegmented
                value={values.schedule_type}
                onChange={(v) => form.setFieldValue('schedule_type', v)}
              />

              {values.schedule_type === 'at' && (
                <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-start">
                  <div>
                    <label htmlFor="task-at-datetime" className="mb-1 block text-xs font-medium text-(--color-text-2)">Date & Time</label>
                    <DateTimePicker
                      id="task-at-datetime"
                      value={values.at_datetime ?? ''}
                      onChange={(v) => form.setFieldValue('at_datetime', v)}
                      triggerClassName="h-8 rounded-sm text-xs bg-(--bg-page)"
                      aria-invalid={!!fieldErrors.at_datetime}
                      aria-describedby={fieldErrors.at_datetime ? 'task-at-datetime-error' : undefined}
                    />
                    {fieldErrors.at_datetime && <p id="task-at-datetime-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.at_datetime}</p>}
                  </div>
                  <div>
                    <label htmlFor="task-timezone" className="mb-1 block text-xs font-medium text-(--color-text-2)">Timezone</label>
                    <Input
                      id="task-timezone"
                      className={`h-8 ${FIELD_CLASS}`}
                      value={values.timezone}
                      onChange={(e) => form.setFieldValue('timezone', e.target.value)}
                      placeholder={localTz}
                    />
                  </div>
                </div>
              )}

              {values.schedule_type === 'cron' && (
                <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-start">
                  <div>
                    <label htmlFor="task-cron-expression" className="mb-1 block text-xs font-medium text-(--color-text-2)">Cron Expression</label>
                    <Input
                      id="task-cron-expression"
                      className={`h-8 ${FIELD_CLASS}`}
                      value={values.cron_expression ?? ''}
                      onChange={(e) => form.setFieldValue('cron_expression', e.target.value)}
                      placeholder="e.g., 0 9 * * MON-FRI"
                      aria-invalid={!!fieldErrors.cron_expression}
                      aria-describedby={fieldErrors.cron_expression ? 'task-cron-expression-error' : undefined}
                    />
                    {fieldErrors.cron_expression && <p id="task-cron-expression-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.cron_expression}</p>}
                    <p className="mt-1 text-xs text-(--color-text-muted)">Standard 5-field cron format (e.g. 0 9 * * MON-FRI)</p>
                  </div>
                  <div>
                    <label htmlFor="task-timezone" className="mb-1 block text-xs font-medium text-(--color-text-2)">Timezone</label>
                    <Input
                      id="task-timezone"
                      className={`h-8 ${FIELD_CLASS}`}
                      value={values.timezone}
                      onChange={(e) => form.setFieldValue('timezone', e.target.value)}
                      placeholder={localTz}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Prompt */}
          <div>
            <label htmlFor="task-prompt" className="mb-1 block text-xs font-medium text-(--color-text-2)">Prompt</label>
            <Textarea
              id="task-prompt"
              className={`font-mono text-xs leading-relaxed ${FIELD_CLASS}`}
              value={values.prompt}
              onChange={(e) => form.setFieldValue('prompt', e.target.value)}
              placeholder="Message to deliver to the agent when the task fires."
              rows={3}
              aria-invalid={!!fieldErrors.prompt}
              aria-describedby={fieldErrors.prompt ? 'task-prompt-error' : undefined}
            />
            {fieldErrors.prompt && <p id="task-prompt-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.prompt}</p>}
          </div>

          {/* Session Target & Max Runs */}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-start">
            <div>
              <label htmlFor="session-target" className="mb-1 block text-xs font-medium text-(--color-text-2)">Session Target</label>
              <Dropdown
                id="session-target"
                value={values.sessionType}
                onValueChange={(v) => form.setFieldValue('sessionType', v as 'new' | 'auto' | 'current' | 'custom')}
                trigger="Session Target"
                className="h-8 w-full rounded-sm border-(--color-border) bg-(--bg-page) px-2.5 text-xs"
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
                  <label htmlFor="custom-session-id" className="sr-only">Session UUID</label>
                  <Input
                    id="custom-session-id"
                    className={`h-8 ${FIELD_CLASS}`}
                    value={values.customSessionId}
                    onChange={(e) => form.setFieldValue('customSessionId', e.target.value)}
                    placeholder="Enter session UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)"
                    aria-invalid={!!fieldErrors.customSessionId}
                    aria-describedby={fieldErrors.customSessionId ? 'custom-session-id-error' : undefined}
                  />
                  {fieldErrors.customSessionId && <p id="custom-session-id-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.customSessionId}</p>}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="task-max-runs" className="mb-1 block text-xs font-medium text-(--color-text-2)">Max runs (optional)</label>
              <Input
                id="task-max-runs"
                type="number"
                min="1"
                className={`h-8 w-full ${FIELD_CLASS}`}
                value={values.max_runs ?? ''}
                onChange={(e) => form.setFieldValue('max_runs', e.target.value ? Number(e.target.value) : null)}
                placeholder="Unlimited"
                aria-invalid={!!fieldErrors.max_runs}
                aria-describedby={fieldErrors.max_runs ? 'task-max-runs-error' : undefined}
              />
              {fieldErrors.max_runs && <p id="task-max-runs-error" className="mt-1 text-xs text-(--color-error)">{fieldErrors.max_runs}</p>}
              <p className="mt-1 text-xs text-(--color-text-muted)">Stop after N runs.</p>
            </div>
          </div>

          {/* Error message */}
          {validationSummary && <p role="alert" className="sr-only">Please correct the highlighted fields.</p>}
          {error && (
            <div role="alert" className="flex gap-2.5 rounded-sm border border-(--color-error)/40 bg-(--color-error-subtle) p-2.5">
              <AlertCircle size={15} className="shrink-0 text-(--color-error)" />
              <p className="text-xs text-(--color-error)">{error}</p>
            </div>
          )}
        </div>

        {/* Submit */}
        <div className="mt-5 flex justify-end">
          <Button
            type="submit"
            variant="primary"
            disabled={createMutation.isPending}
            size="sm"
            className="h-8 min-w-28 text-xs font-medium"
          >
            {createMutation.isPending ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Plus size={13} />
                Create Task
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
