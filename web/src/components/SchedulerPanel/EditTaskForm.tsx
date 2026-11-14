import { useState, useEffect } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUpdateScheduledTaskMutation } from '@/queries'
import type { ScheduledTaskResponse } from '@/api/types'

import { Callout } from '@/components/ui/callout'
import { editTaskDefaults, toUpdatePayload, validateTaskValues } from './taskForm'
import { useTaskFieldErrors } from './useTaskFieldErrors'
import { taskValuesChanged, useReportSchedulerDraft } from './draftGuard'
import { TaskFields, TaskPageButton, pageWithErrors, type TaskFormPage } from './TaskFields'
import { useAgentStore } from '@/stores/useAgentStore'
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
   * "Edit task" title but drop the repeated name.
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
  const [page, setPage] = useState<TaskFormPage>('main')
  const updateMutation = useUpdateScheduledTaskMutation()
  const form = useForm({ defaultValues: defaults, onSubmit: () => {} })
  const values = useStore(form.store, (state) => state.values)
  const { formRef, fieldErrors, validateForSubmit } = useTaskFieldErrors(values)
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
    if (!validateForSubmit(submitValues)) {
      setPage(pageWithErrors(validateTaskValues(submitValues), page))
      return
    }
    updateMutation.mutate(
      { slug: task.slug, body: toUpdatePayload(submitValues, localTz, currentSessionId) },
      { onSuccess, onError: (err) => setError(err instanceof Error ? err.message : "Couldn't update task") },
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-(--bg-page)">
      {/* Header: the same one as the create form's. No × of its own: the
          overlay has one, and the footer has Cancel. */}
      <div className={headerClass}>
        <div className="flex items-center gap-2">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-(--color-text)">Edit task</h2>
            {!hostTitled && <p className="text-meta leading-relaxed text-(--color-text-muted)">{task.name}</p>}
          </div>
        </div>
      </div>

      {/* Form */}
      <form ref={formRef} onSubmit={handleSubmit} onKeyDown={advanceFocusOnEnter} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain touch-pan-y px-4 py-5 @xl:px-6 @xl:py-6">
          <TaskFields
            idPrefix="edit-task"
            mode="edit"
            page={page}
            values={values}
            set={(key, value) => form.setFieldValue(key, value as never)}
            fieldErrors={fieldErrors}
            localTz={localTz}
            currentSessionTitle={currentSessionTitle}
            sessionCompatible={isSessionCompatible}
          />

          {/* Error message */}
          {validationSummary && <p role="alert" className="sr-only">Please correct the highlighted fields.</p>}
          {error && (
            <Callout tone="error" role="alert">{error}</Callout>
          )}
        </div>

        {/* Actions */}
        <div className={cn('flex shrink-0 items-center justify-end gap-2 border-t border-(--color-border-subtle) bg-(--bg-sidebar) px-4 py-3 @xl:px-6', footerSafeArea)}>
          <TaskPageButton page={page} onChange={setPage} />
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
