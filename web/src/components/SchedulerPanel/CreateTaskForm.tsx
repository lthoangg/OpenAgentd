import { useState, useEffect } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { Loader2, Plus } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCreateScheduledTaskMutation } from '@/queries'
import { FIELD_CLASS, FIELD_ERROR, FIELD_HINT, FIELD_LABEL, slugify } from './utils'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { createTaskDefaults, toCreatePayload, validateTaskValues, type TaskFormErrors } from './taskForm'
import { ScheduleTypeSegmented } from './ScheduleTypeSegmented'
import { ModeWorkspaceFields } from './ModeWorkspaceFields'
import { useAgentStore } from '@/stores/useAgentStore'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { SchedulerBackButton, useSchedulerFooterSafeArea, useSchedulerPaneHeaderClass } from './chrome'
import { cn } from '@/lib/utils'

export function CreateTaskForm({
  contextWorkspace,
  onSuccess,
  onBack,
  hostTitled = false,
}: {
  contextWorkspace: string | null
  onSuccess: () => void
  /** Stacked hosts (the dock) get a leading back arrow to the task list. */
  onBack?: () => void
  /** The host header already says "New task" (the phone overlay): skip the pane header. */
  hostTitled?: boolean
}) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const defaults = createTaskDefaults(contextWorkspace, localTz)
  const headerClass = useSchedulerPaneHeaderClass()
  const footerSafeArea = useSchedulerFooterSafeArea()
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
      {!hostTitled && (
        <div className={headerClass}>
          <div className="flex items-center gap-2">
            {onBack && <SchedulerBackButton onClick={onBack} />}
            <div className="flex h-6 w-6 items-center justify-center rounded-sm border border-(--color-accent)/30 bg-(--color-accent)/10 text-(--color-accent)">
              <Plus size={13} />
            </div>
            <h2 className="text-base font-semibold tracking-tight text-(--color-text)">Create task</h2>
          </div>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-8 overflow-y-auto overscroll-contain touch-pan-y px-4 py-5 @xl:px-6 @xl:py-6">
          <PanelSection title="Task" contentClassName="space-y-5">
            {/* Title */}
            <div>
              <label htmlFor="task-title" className={FIELD_LABEL}>Task title</label>
              <Input
                id="task-title"
                className={`h-9 ${FIELD_CLASS}`}
                value={values.title}
                onChange={(e) => form.setFieldValue('title', e.target.value)}
                placeholder="e.g., Daily Standup Report"
                maxLength={100}
                aria-invalid={!!fieldErrors.title}
                aria-describedby={fieldErrors.title ? 'task-title-error' : undefined}
              />
              {fieldErrors.title && <p id="task-title-error" className={FIELD_ERROR}>{fieldErrors.title}</p>}
              {values.title && (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-(--color-text-muted)">
                  <span>Slug:</span>
                  <code className="rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/80 px-1.5 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-2)">
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
          </PanelSection>

          {/* Schedule Type & Detail */}
          <PanelSection title="Schedule">
            {values.schedule_type === 'every' ? (
              <div className="grid gap-x-4 gap-y-5 @xl:grid-cols-2 @xl:items-start">
                <div>
                  <label className={FIELD_LABEL}>Schedule type</label>
                  <ScheduleTypeSegmented
                    value={values.schedule_type}
                    onChange={(v) => form.setFieldValue('schedule_type', v)}
                  />
                </div>
                <div>
                  <label htmlFor="task-every-seconds" className={FIELD_LABEL}>Interval (seconds)</label>
                  <Input
                    id="task-every-seconds"
                    className={`h-9 w-full ${FIELD_CLASS}`}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={values.every_seconds ?? 3600}
                    onChange={(e) =>
                      form.setFieldValue('every_seconds', parseInt(e.target.value) || 0)
                    }
                    aria-invalid={!!fieldErrors.every_seconds}
                    aria-describedby={fieldErrors.every_seconds ? 'task-every-seconds-error' : 'task-every-seconds-help'}
                  />
                  {fieldErrors.every_seconds && <p id="task-every-seconds-error" className={FIELD_ERROR}>{fieldErrors.every_seconds}</p>}
                  <p id="task-every-seconds-help" className={FIELD_HINT}>e.g., 3600 = 1 hour, 86400 = 1 day</p>
                </div>
              </div>
            ) : (
              <div>
                <label className={FIELD_LABEL}>Schedule type</label>
                <ScheduleTypeSegmented
                  value={values.schedule_type}
                  onChange={(v) => form.setFieldValue('schedule_type', v)}
                />

                {values.schedule_type === 'at' && (
                  <div className="mt-5 grid gap-x-4 gap-y-5 @xl:grid-cols-[minmax(0,1fr)_12rem] @xl:items-start">
                    <div>
                      <label htmlFor="task-at-datetime" className={FIELD_LABEL}>Date and time</label>
                      <DateTimePicker
                        id="task-at-datetime"
                        value={values.at_datetime ?? ''}
                        onChange={(v) => form.setFieldValue('at_datetime', v)}
                        triggerClassName="h-9 rounded-sm text-xs bg-(--bg-page)"
                        aria-invalid={!!fieldErrors.at_datetime}
                        aria-describedby={fieldErrors.at_datetime ? 'task-at-datetime-error' : undefined}
                      />
                      {fieldErrors.at_datetime && <p id="task-at-datetime-error" className={FIELD_ERROR}>{fieldErrors.at_datetime}</p>}
                    </div>
                    <div>
                      <label htmlFor="task-timezone" className={FIELD_LABEL}>Timezone</label>
                      <Input
                        id="task-timezone"
                        className={`h-9 ${FIELD_CLASS}`}
                        value={values.timezone}
                        onChange={(e) => form.setFieldValue('timezone', e.target.value)}
                        placeholder={localTz}
                      />
                    </div>
                  </div>
                )}

                {values.schedule_type === 'cron' && (
                  <div className="mt-5 grid gap-x-4 gap-y-5 @xl:grid-cols-[minmax(0,1fr)_12rem] @xl:items-start">
                    <div>
                      <label htmlFor="task-cron-expression" className={FIELD_LABEL}>Cron expression</label>
                      <Input
                        id="task-cron-expression"
                        className={`h-9 ${FIELD_CLASS}`}
                        value={values.cron_expression ?? ''}
                        onChange={(e) => form.setFieldValue('cron_expression', e.target.value)}
                        placeholder="e.g., 0 9 * * MON-FRI"
                        aria-invalid={!!fieldErrors.cron_expression}
                        aria-describedby={fieldErrors.cron_expression ? 'task-cron-expression-error' : undefined}
                      />
                      {fieldErrors.cron_expression && <p id="task-cron-expression-error" className={FIELD_ERROR}>{fieldErrors.cron_expression}</p>}
                      <p className={FIELD_HINT}>Standard 5-field cron format (e.g. 0 9 * * MON-FRI)</p>
                    </div>
                    <div>
                      <label htmlFor="task-timezone" className={FIELD_LABEL}>Timezone</label>
                      <Input
                        id="task-timezone"
                        className={`h-9 ${FIELD_CLASS}`}
                        value={values.timezone}
                        onChange={(e) => form.setFieldValue('timezone', e.target.value)}
                        placeholder={localTz}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </PanelSection>

          {/* Prompt */}
          <PanelSection title="Prompt">
            <div>
              <label htmlFor="task-prompt" className="sr-only">Prompt</label>
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
              {fieldErrors.prompt && <p id="task-prompt-error" className={FIELD_ERROR}>{fieldErrors.prompt}</p>}
            </div>
          </PanelSection>

          {/* Session Target & Max Runs */}
          <PanelSection title="Delivery">
            <div className="grid gap-x-4 gap-y-5 @xl:grid-cols-[minmax(0,1fr)_9rem] @xl:items-start">
              <div>
                <label htmlFor="session-target" className={FIELD_LABEL}>Session target</label>
                <Dropdown
                  id="session-target"
                  value={values.sessionType}
                  onValueChange={(v) => form.setFieldValue('sessionType', v as 'new' | 'auto' | 'current' | 'custom')}
                  trigger="Session target"
                  className="h-9 w-full rounded-sm border-(--color-border) bg-(--bg-page) px-2.5 text-xs"
                >
                  <DropdownItem value="new">New session</DropdownItem>
                  <DropdownItem value="auto">Persistent task session</DropdownItem>
                  {isSessionCompatible && (
                    <DropdownItem value="current">
                      Current chat session ({currentSessionTitle ? `"${currentSessionTitle}"` : 'Active'})
                    </DropdownItem>
                  )}
                  <DropdownItem value="custom">Specific session ID…</DropdownItem>
                </Dropdown>
                <p className={FIELD_HINT}>
                  {values.sessionType === 'new' && 'Creates a fresh, isolated chat session for every run.'}
                  {values.sessionType === 'auto' && 'Runs all executions in a single dedicated chat session created for this task.'}
                  {values.sessionType === 'current' && 'Delivers the prompt directly into your active chat thread.'}
                  {values.sessionType === 'custom' && 'Delivers the prompt to a specific chat session by its UUID.'}
                </p>

                {values.sessionType === 'custom' && (
                  <div className="mt-3">
                    <label htmlFor="custom-session-id" className="sr-only">Session UUID</label>
                    <Input
                      id="custom-session-id"
                      className={`h-9 ${FIELD_CLASS}`}
                      value={values.customSessionId}
                      onChange={(e) => form.setFieldValue('customSessionId', e.target.value)}
                      placeholder="Enter session UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)"
                      aria-invalid={!!fieldErrors.customSessionId}
                      aria-describedby={fieldErrors.customSessionId ? 'custom-session-id-error' : undefined}
                    />
                    {fieldErrors.customSessionId && <p id="custom-session-id-error" className={FIELD_ERROR}>{fieldErrors.customSessionId}</p>}
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="task-max-runs" className={FIELD_LABEL}>Max runs (optional)</label>
                <Input
                  id="task-max-runs"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  className={`h-9 w-full ${FIELD_CLASS}`}
                  value={values.max_runs ?? ''}
                  onChange={(e) => form.setFieldValue('max_runs', e.target.value ? Number(e.target.value) : null)}
                  placeholder="Unlimited"
                  aria-invalid={!!fieldErrors.max_runs}
                  aria-describedby={fieldErrors.max_runs ? 'task-max-runs-error' : undefined}
                />
                {fieldErrors.max_runs && <p id="task-max-runs-error" className={FIELD_ERROR}>{fieldErrors.max_runs}</p>}
                <p className={FIELD_HINT}>Stop after N runs.</p>
              </div>
            </div>
          </PanelSection>

          {/* Error message */}
          {validationSummary && <p role="alert" className="sr-only">Please correct the highlighted fields.</p>}
          {error && (
            <Callout tone="error" role="alert">{error}</Callout>
          )}
        </div>

        {/* Submit */}
        <div className={cn('flex shrink-0 flex-wrap justify-end gap-2 border-t border-(--color-border) bg-(--bg-sidebar) px-4 py-3 @xl:px-6', footerSafeArea)}>
          <Button
            type="submit"
            variant="primary"
            disabled={createMutation.isPending}
            className="w-full md:w-auto md:min-w-28"
          >
            {createMutation.isPending ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Plus size={13} aria-hidden="true" />
                Create task
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
