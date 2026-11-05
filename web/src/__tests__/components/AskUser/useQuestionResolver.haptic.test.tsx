/**
 * Every answer — a question's Send, a confirmation's Approve or Deny, the
 * composer's reply — goes through ``useQuestionResolver.answer``: a soft tick
 * on a phone as it is tapped.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const haptics: string[] = []
mock.module('@/lib/haptics', () => ({
  softHapticFeedback: () => haptics.push('soft'),
  mediumHapticFeedback: () => haptics.push('medium'),
  selectionHapticFeedback: () => haptics.push('selection'),
  outcomeHapticFeedback: () => haptics.push('outcome'),
  haptic: () => haptics.push('haptic'),
}))

const { useQuestionResolver } = await import('@/components/AskUser/useQuestionResolver')
const { useAgentStore } = await import('@/stores/useAgentStore')

const REAL_FETCH = globalThis.fetch
const question = { id: 'q1', kind: 'confirmation', questions: [] } as never

beforeEach(() => {
  haptics.length = 0
  useAgentStore.setState({ sessionId: 's1' })
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ resumed: true }))) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  globalThis.fetch = REAL_FETCH
})

describe('useQuestionResolver — haptic', () => {
  it('ticks once when an answer is sent', async () => {
    const { result } = renderHook(() => useQuestionResolver(question))
    await act(async () => { result.current.answer([['Approve']]) })
    expect(haptics).toEqual(['soft'])
  })

  it('stays quiet when there is no open question to answer', async () => {
    const { result } = renderHook(() => useQuestionResolver(null))
    await act(async () => { result.current.answer([['Approve']]) })
    expect(haptics).toEqual([])
  })
})
