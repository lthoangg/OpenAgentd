/**
 * Unsaved-input guard for the scheduler's Create and Edit forms. A form
 * reports whether it differs from what it opened with; the host (overlay or
 * dock tab) wraps every navigation that would unmount the form in `guard`,
 * which asks "Discard changes?" first when there is something to lose.
 * A successful submit navigates without the guard, and the form's own
 * Cancel stays an immediate, deliberate discard.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { TaskFormValues } from './taskForm'

const SchedulerDraftContext = createContext<((dirty: boolean) => void) | null>(null)

/** True when `values` differ from what the form opened with. */
export function taskValuesChanged(values: TaskFormValues, initial: TaskFormValues): boolean {
  return (Object.keys(initial) as (keyof TaskFormValues)[]).some((key) => values[key] !== initial[key])
}

/** Called by a form with its current dirty state; cleared when it unmounts. */
export function useReportSchedulerDraft(dirty: boolean): void {
  const report = useContext(SchedulerDraftContext)
  useEffect(() => {
    report?.(dirty)
  }, [report, dirty])
  useEffect(() => () => report?.(false), [report])
}

export function useSchedulerDraftGuard() {
  const dirtyRef = useRef(false)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const report = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
  }, [])

  const guard = useCallback((action: () => void) => {
    if (!dirtyRef.current) {
      action()
      return
    }
    setPending(() => action)
  }, [])

  const discard = () => {
    const action = pending
    setPending(null)
    dirtyRef.current = false
    action?.()
  }

  const provide = (children: ReactNode) => (
    <SchedulerDraftContext.Provider value={report}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null) }}
        title="Discard changes?"
        description="Your changes to this task have not been saved."
        confirmLabel="Discard changes"
        onConfirm={discard}
      />
    </SchedulerDraftContext.Provider>
  )

  return { guard, provide }
}
