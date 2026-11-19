/** A copy control that turns to "Copied" also taps softly on a phone; a refused copy does not. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const haptics: string[] = []
const realHaptics = await import('@/lib/haptics')
mock.module('@/lib/haptics', () => ({ ...realHaptics, softHapticFeedback: () => { haptics.push('soft') } }))

import { useCopyFeedback } from '@/hooks/use-copy-feedback'

function withClipboard(writeText: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
}

beforeEach(() => { haptics.length = 0 })
afterEach(cleanup)

describe('useCopyFeedback haptics', () => {
  it('taps softly when the text was copied', async () => {
    withClipboard(async () => {})
    const { result } = renderHook(() => useCopyFeedback())
    await act(async () => { await result.current.copy('x') })
    expect(haptics).toEqual(['soft'])
  })

  it('stays quiet when the clipboard refused', async () => {
    withClipboard(async () => { throw new Error('denied') })
    const { result } = renderHook(() => useCopyFeedback())
    await act(async () => { await result.current.copy('x') })
    expect(result.current.copied).toBe(false)
    expect(haptics).toEqual([])
  })
})
