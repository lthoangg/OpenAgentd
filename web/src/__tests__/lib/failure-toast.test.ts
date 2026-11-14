import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { ApiValidationError } from '@/api/client/_shared'
import { failureToast, pushFailureToast } from '@/lib/failure-toast'
import { useToastStore } from '@/stores/useToastStore'

const writeText = mock(async (..._args: unknown[]) => {})

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  useToastStore.setState({ toasts: [] })
})

afterEach(() => useToastStore.setState({ toasts: [] }))

describe('failureToast', () => {
  it("keeps a sentence the server wrote for people as the toast's second line", () => {
    const toast = failureToast("Couldn't start the goal", new Error('Approve the plan first: a goal runs the approved plan.'))

    expect(toast).toEqual({
      tone: 'error',
      title: "Couldn't start the goal",
      description: 'Approve the plan first: a goal runs the approved plan.',
    })
  })

  it("puts the machine's words behind Copy details and says what to do instead", () => {
    const err = new ApiValidationError(409, 'startGoal failed: 409', { reason: 'plan_revision_mismatch', expected: 3 })
    const toast = failureToast("Couldn't start the goal", err)

    expect(toast.description).toBe('Try again, or copy the details for a bug report.')
    expect(toast.action?.label).toBe('Copy details')
    toast.action?.onAction()
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = String(writeText.mock.calls[0][0])
    expect(copied).toContain("Couldn't start the goal")
    expect(copied).toContain('startGoal failed: 409')
    expect(copied).toContain('Status: 409')
    expect(copied).toContain('plan_revision_mismatch')
  })

  it.each([
    'HTTP 409: {"detail":"plan_revision_mismatch: expected 3 got 2"}',
    'Failed to fetch',
    'Load failed',
    'plan_revision_mismatch',
    "TypeError: undefined is not an object (evaluating 'a.b')",
    'fatal: bad object HEAD\nerror: could not read',
  ])('treats %p as machine text', (message) => {
    const toast = failureToast("Couldn't save", new Error(message))

    expect(toast.description).toBe('Try again, or copy the details for a bug report.')
    expect(toast.action?.label).toBe('Copy details')
  })

  it('says the cause when the caller knows it, and still keeps the details one click away', () => {
    const toast = failureToast("Couldn't start the goal", new Error('startGoal failed: 409'), 'The plan changed. Open it and try again.')

    expect(toast.description).toBe('The plan changed. Open it and try again.')
    expect(toast.action?.label).toBe('Copy details')
  })

  it('shows the title alone when the failure carries no text', () => {
    expect(failureToast("Couldn't pin session", undefined)).toEqual({ tone: 'error', title: "Couldn't pin session" })
  })

  it('pushes a toast that stays until it is closed', () => {
    pushFailureToast("Couldn't save", new Error('save failed: 500'))

    const [toast] = useToastStore.getState().toasts
    expect(toast.title).toBe("Couldn't save")
    expect(toast.durationMs).toBeNull()
  })
})

describe('failureSentence', () => {
  it('keeps a sentence and drops machine text, for a toast whose button is Retry', async () => {
    const { failureSentence } = await import('@/lib/failure-toast')

    expect(failureSentence(new Error('Choose a model from the registry.'))).toBe('Choose a model from the registry.')
    expect(failureSentence(new Error('updateSession failed: 500'))).toBeUndefined()
    expect(failureSentence(null)).toBeUndefined()
  })
})
