import { useEffect, useRef, useState } from 'react'
import { validateTaskValues, type TaskFormErrors, type TaskFormValues } from './taskForm'

/**
 * Field errors for the scheduler forms, on the native timing: nothing while
 * the form is first filled in; a failed submit shows every problem and moves
 * focus to the first one; from then on a field that has shown an error is
 * re-checked as it changes, so the message leaves the moment it is fixed
 * (and returns if the field breaks again).
 */
export function useTaskFieldErrors(values: TaskFormValues, requireTitle: boolean) {
  const formRef = useRef<HTMLFormElement>(null)
  const [shownKeys, setShownKeys] = useState<ReadonlySet<keyof TaskFormValues>>(() => new Set())
  const [focusRequest, setFocusRequest] = useState(0)

  const live = shownKeys.size ? validateTaskValues(values, requireTitle) : {}
  const fieldErrors: TaskFormErrors = {}
  for (const key of shownKeys) if (live[key]) fieldErrors[key] = live[key]

  useEffect(() => {
    if (!focusRequest) return
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [focusRequest])

  /** Validates for a submit; false (and errors shown) when it must not go ahead. */
  const validateForSubmit = (submitValues: TaskFormValues): boolean => {
    const errors = validateTaskValues(submitValues, requireTitle)
    const keys = Object.keys(errors) as (keyof TaskFormValues)[]
    if (!keys.length) return true
    setShownKeys((prev) => new Set([...prev, ...keys]))
    setFocusRequest((n) => n + 1)
    return false
  }

  const resetErrors = () => setShownKeys(new Set())

  return { formRef, fieldErrors, validateForSubmit, resetErrors }
}
