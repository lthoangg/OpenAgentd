/**
 * useCopyFeedback — the one "Copied" flag every copy control uses: a second
 * copy restarts the timer (it used to revert early where each control kept
 * its own setTimeout), and the timer stops with the component.
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

import { useCopyFeedback } from '@/hooks/use-copy-feedback'

afterEach(cleanup)

function withClipboard(writeText: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
}

describe('useCopyFeedback', () => {
  it('says copied, and a second copy restarts the timer instead of ending it early', async () => {
    const writeText = mock(async (_text: unknown) => {})
    withClipboard(writeText)
    const set = spyOn(globalThis, 'setTimeout')
    const clear = spyOn(globalThis, 'clearTimeout')
    try {
      const { result } = renderHook(() => useCopyFeedback(1500))
      await act(async () => { await result.current.copy('one') })
      expect(result.current.copied).toBe(true)
      await act(async () => { await result.current.copy('two') })
      expect(writeText.mock.calls.map((call) => call[0])).toEqual(['one', 'two'])
      // The first timer was cancelled before the second started.
      expect(clear).toHaveBeenCalled()
      expect(set.mock.calls.filter((call) => call[1] === 1500)).toHaveLength(2)
    } finally {
      set.mockRestore()
      clear.mockRestore()
    }
  })

  it('stops its timer on unmount', async () => {
    withClipboard(async () => {})
    const clear = spyOn(globalThis, 'clearTimeout')
    try {
      const { result, unmount } = renderHook(() => useCopyFeedback())
      await act(async () => { await result.current.copy('x') })
      const before = clear.mock.calls.length
      unmount()
      expect(clear.mock.calls.length).toBe(before + 1)
    } finally {
      clear.mockRestore()
    }
  })

  it('leaves the flag off when the clipboard refuses', async () => {
    withClipboard(async () => { throw new Error('denied') })
    const { result } = renderHook(() => useCopyFeedback())
    let ok = true
    await act(async () => { ok = await result.current.copy('x') })
    expect(ok).toBe(false)
    expect(result.current.copied).toBe(false)
  })
})
