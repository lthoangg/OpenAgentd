import { useState, useEffect } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { Loader2, Pencil, X } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateScheduledTaskMutation } from '@/queries'
import type { ScheduledTaskResponse } from '@/api/types'

import { FIELD_CLASS, FIELD_ERROR, FIELD_HINT, FIELD_LABEL } from './utils'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { editTaskDefaults, toUpdatePayload } from './taskForm'
import { useTaskFieldErrors } from './useTaskFieldErrors'
import { taskValuesChanged, useReportSchedulerDraft } from './draftGuard'
import { ScheduleTypeSegmented } from './ScheduleTypeSegmented'
import { ModeWorkspaceFields } from './ModeWorkspaceFields'
import { useAgentStore } from '@/stores/useAgentStore'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { useSchedulerFooterSafeArea, useSchedulerPaneHeaderClass } from './chrome'
import { advanceFocusOnEnter } from './formNavigation'
import { cn } from '@/lib/utils'

export function EditTaskForm({
  task,
  onSuccess,
  onCancel,
  hostTitled = false,
}: {
  task: ScheduledTaskResponse
  onSuccess: () => void
  onCancel: () => void
  /**
   * The host header already shows the task name (the phone overlay): keep the
   * "Edit task" title but drop the repeated name and the X, since the footer
   * has Cancel.
   */
  hostTitled?: boolean
}) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const headerClass = useSchedulerPaneHeaderClass()
  const footerSafeArea = useSchedulerFooterSafeArea()
  const currentSessionId = useAgentStore((state) => state.sessionId)
  const currentSessionTitle = useAgentStore((state) => state.sessionTitle)
  const activeSessionWorkspace = useAgentStore((state) => state._workspace)

  const defaults = editTaskDefaults(task, currentSessionId)
  const [error, setError] = useState<string | null>(null)
  const updateMutation = useUpdateScheduledTaskMutation()
  const form = useForm({ defaultValues: defaults, onSubmit: () => {} })
  const values = useStore(form.store, (state) => state.values)
  const { formRef, fieldErrors, validateForSubmit } = useTaskFieldErrors(values, false)
  useReportSchedulerDraft(taskValuesChanged(values, defaults))
  const validationSummary = Object.values(fieldErrors)[0]
  const isSessionCompatible = !!currentSessionId && values.workspace === activeSessionWorkspace

  useEffect(() => {
    if (!isSessionCompatible && values.sessionType === 'current') form.setFieldValue('sessionType', 'new')
  }, [form, isSessionCompatible, values.sessionType])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const submitValues = form.state.values
    if (!validateForSubmit(submitValues)) return
    updateMutation.mutate(
      { slug: task.slug, body: toUpdatePayload(submitValues, localTz, currentSessionId) },
      { onSuccess, onError: (err) => setError(err instanceof Error ? err.message : 'Failed to update task') },
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-(--bg-page)">
      {/* Header */}
      <div className={headerClass}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-sm border border-(--color-accent)/30 bg-(--color-accent)/10 text-(--color-accent)">
              <Pencil size={12} />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-(--color-text)">Edit task</h2>
              {!hostTitled && <p className="text-[11px] leading-relaxed text-(--color-text-muted)">{task.name}</p>}
            </div>
          </div>
          {!hostTitled && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onCancel}
                    className="h-9 w-9 rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
                    aria-label="Cancel edit"
                  >
                    <X size={13} />
                  </Button>
                }
              />
              <TooltipContent>Cancel</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Form */}
      <form ref={formRef} onSubmit={handleSubmit} onKeyDown={advanceFocusOnEnter} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-8 overflow-y-auto overscroll-contain touch-pan-y px-4 py-5 @xl:px-6 @xl:py-6">
          <PanelSection title="Task">
            {/* Routing */}
            <ModeWorkspaceFields
              workspace={values.workspace ?? null}
              onChange={(workspace) => form.setFieldValue('workspace', workspace ?? '')}
              workspaceError={fieldErrors.workspace}
              workspaceErrorId="edit-task-workspace-error"
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
                  <label htmlFor="edit-task-every-seconds" className={FIELD_LABEL}>Interval (seconds)</label>
                  <Input
                    id="edit-task-every-seconds"
                    enterKeyHint="next"
                    className={`h-9 w-full ${FIELD_CLASS}`}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={values.every_seconds ?? 3600}
                    onChange={(e) =>
                      form.setFieldValue('every_seconds', parseInt(e.target.value) || 0)
                    }
                    aria-invalid={!!fieldErrors.every_seconds}
                    aria-describedby={fieldErrors.every_seconds ? 'edit-task-every-seconds-error' : 'edit-task-every-seconds-help'}
                  />
                  {fieldErrors.every_seconds && <p id="edit-task-every-seconds-error" className={FIELD_ERROR}>{fieldErrors.every_seconds}</p>}
                  <p id="edit-task-every-seconds-help" className={FIELD_HINT}>e.g., 3600 = 1 hour, 86400 = 1 day</p>
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
                      <label htmlFor="edit-task-at-datetime" className={FIELD_LABEL}>Date and time</label>
                      <DateTimePicker
                        id="edit-task-at-datetime"
                        value={values.at_datetime ?? ''}
                        onChange={(v) => form.setFieldValue('at_datetime', v)}
                        triggerClassName="h-9 rounded-sm text-xs bg-(--bg-page)"
                        aria-invalid={!!fieldErrors.at_datetime}
                        aria-describedby={fieldErrors.at_datetime ? 'edit-task-at-datetime-error' : undefined}
                      />
                      {fieldErrors.at_datetime && <p id="edit-task-at-datetime-error" className={FIELD_ERROR}>{fieldErrors.at_datetime}</p>}
                    </div>
                    <div>
                      <label htmlFor="edit-task-timezone" className={FIELD_LABEL}>Timezone</label>
                      <Input
                        id="edit-task-timezone"
                        enterKeyHint="next"
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
                      <label htmlFor="edit-task-cron-expression" className={FIELD_LABEL}>Cron expression</label>
                      <Input
                        id="edit-task-cron-expression"
                        enterKeyHint="next"
                        className={`h-9 ${FIELD_CLASS}`}
                        value={values.cron_expression ?? ''}
                        onChange={(e) => form.setFieldValue('cron_expression', e.target.value)}
                        placeholder="e.g., 0 9 * * MON-FRI"
                        aria-invalid={!!fieldErrors.cron_expression}
                        aria-describedby={fieldErrors.cron_expression ? 'edit-task-cron-expression-error' : undefined}
                      />
                      {fieldErrors.cron_expression && <p id="edit-task-cron-expression-error" className={FIELD_ERROR}>{fieldErrors.cron_expression}</p>}
                      <p className={FIELD_HINT}>Standard 5-field cron format (e.g. 0 9 * * MON-FRI)</p>
                    </div>
                    <div>
                      <label htmlFor="edit-task-timezone" className={FIELD_LABEL}>Timezone</label>
                      <Input
                        id="edit-task-timezone"
                        enterKeyHint="next"
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
              <label htmlFor="edit-task-prompt" className="sr-only">Prompt</label>
              <Textarea
                id="edit-task-prompt"
                className={`font-mono text-xs leading-relaxed ${FIELD_CLASS}`}
                value={values.prompt}
                onChange={(e) => form.setFieldValue('prompt', e.target.value)}
                placeholder="Message to deliver to the agent when the task fires."
                rows={3}
                aria-invalid={!!fieldErrors.prompt}
                aria-describedby={fieldErrors.prompt ? 'edit-task-prompt-error' : undefined}
              />
              {fieldErrors.prompt && <p id="edit-task-prompt-error" className={FIELD_ERROR}>{fieldErrors.prompt}</p>}
            </div>
          </PanelSection>

          {/* Session Target & Max Runs */}
          <PanelSection title="Delivery">
            <div className="grid gap-x-4 gap-y-5 @xl:grid-cols-[minmax(0,1fr)_9rem] @xl:items-start">
              <div>
                <label htmlFor="edit-session-target" className={FIELD_LABEL}>Session target</label>
                <Dropdown
                  id="edit-session-target"
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
                    <label htmlFor="edit-custom-session-id" className="sr-only">Session UUID</label>
                    <Input
                      id="edit-custom-session-id"
                      enterKeyHint="next"
                      className={`h-9 ${FIELD_CLASS}`}
                      value={values.customSessionId}
                      onChange={(e) => form.setFieldValue('customSessionId', e.target.value)}
                      placeholder="Enter session UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)"
                      aria-invalid={!!fieldErrors.customSessionId}
                      aria-describedby={fieldErrors.customSessionId ? 'edit-custom-session-id-error' : undefined}
                    />
                    {fieldErrors.customSessionId && <p id="edit-custom-session-id-error" className={FIELD_ERROR}>{fieldErrors.customSessionId}</p>}
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="edit-task-max-runs" className={FIELD_LABEL}>Max runs (optional)</label>
                <Input
                  id="edit-task-max-runs"
                  // The last field: Enter moves to the Save button (formNavigation).
                  enterKeyHint="done"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  className={`h-9 w-full ${FIELD_CLASS}`}
                  value={values.max_runs ?? ''}
                  onChange={(e) => form.setFieldValue('max_runs', e.target.value ? Number(e.target.value) : null)}
                  placeholder="Unlimited"
                  aria-invalid={!!fieldErrors.max_runs}
                  aria-describedby={fieldErrors.max_runs ? 'edit-task-max-runs-error' : 'edit-task-max-runs-help'}
                />
                {fieldErrors.max_runs && <p id="edit-task-max-runs-error" className={FIELD_ERROR}>{fieldErrors.max_runs}</p>}
                <p id="edit-task-max-runs-help" className={FIELD_HINT}>Stop after N runs.</p>
              </div>
            </div>
          </PanelSection>

          {/* Error message */}
          {validationSummary && <p role="alert" className="sr-only">Please correct the highlighted fields.</p>}
          {error && (
            <Callout tone="error" role="alert">{error}</Callout>
          )}
        </div>

        {/* Actions */}
        <div className={cn('flex shrink-0 flex-wrap justify-end gap-2 border-t border-(--color-border) bg-(--bg-sidebar) px-4 py-3 @xl:px-6', footerSafeArea)}>
          <Button
            type="button"
            variant="default"
            onClick={onCancel}
            disabled={updateMutation.isPending}
            className="flex-1 md:flex-none"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={updateMutation.isPending}
            className="flex-1 md:min-w-28 md:flex-none"
          >
            {updateMutation.isPending ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Saving…
              </>
            ) : (
              'Save changes'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
