import { useState, useEffect } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCreateScheduledTaskMutation, useScheduledTasksQuery } from '@/queries'
import { Callout } from '@/components/ui/callout'
import { createTaskDefaults, toCreatePayload, validateTaskValues } from './taskForm'
import { useTaskFieldErrors } from './useTaskFieldErrors'
import { taskValuesChanged, useReportSchedulerDraft } from './draftGuard'
import { TaskFields, TaskPageButton, pageWithErrors, type TaskFormPage } from './TaskFields'
import { useAgentStore } from '@/stores/useAgentStore'
import { SchedulerBackButton, useSchedulerFooterSafeArea, useSchedulerPaneHeaderClass } from './chrome'
import { advanceFocusOnEnter } from './formNavigation'
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
  const [page, setPage] = useState<TaskFormPage>('main')

  const currentSessionId = useAgentStore((state) => state.sessionId)
  const currentSessionTitle = useAgentStore((state) => state.sessionTitle)
  const activeSessionWorkspace = useAgentStore((state) => state._workspace)

  const createMutation = useCreateScheduledTaskMutation()
  const { data: existing } = useScheduledTasksQuery()
  const form = useForm({
    defaultValues: defaults,
    onSubmit: () => {},
  })
  const values = useStore(form.store, (state) => state.values)
  const { formRef, fieldErrors, validateForSubmit, resetErrors } = useTaskFieldErrors(values)
  useReportSchedulerDraft(taskValuesChanged(values, defaults))
  const validationSummary = Object.values(fieldErrors)[0]
  const isSessionCompatible =
    !!currentSessionId &&
    values.workspace === activeSessionWorkspace

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const submitValues = form.state.values
    if (!validateForSubmit(submitValues)) {
      setPage(pageWithErrors(validateTaskValues(submitValues), page))
      return
    }
    // Task names are unique: a name written from the prompt steps past the ones taken.
    const takenSlugs = existing?.tasks.map((task) => task.slug) ?? []
    const payload = toCreatePayload(submitValues, localTz, currentSessionId, takenSlugs)

    createMutation.mutate(payload, {
      onSuccess: () => {
        form.reset()
        resetErrors()
        setPage('main')
        onSuccess()
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : "Couldn't create task")
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
            <h2 className="text-base font-semibold tracking-tight text-(--color-text)">New task</h2>
          </div>
        </div>
      )}

      {/* Form */}
      <form ref={formRef} onSubmit={handleSubmit} onKeyDown={advanceFocusOnEnter} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain touch-pan-y px-4 py-5 @xl:px-6 @xl:py-6">
          <TaskFields
            idPrefix="task"
            mode="create"
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

        {/* Submit */}
        <div className={cn('flex shrink-0 items-center justify-end gap-3 border-t border-(--color-border-subtle) bg-(--bg-sidebar) px-4 py-3 @xl:px-6', footerSafeArea)}>
          <TaskPageButton page={page} onChange={setPage} />
          <Button
            type="submit"
            variant="primary"
            disabled={createMutation.isPending}
            className="flex-1 md:min-w-28 md:flex-none"
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
