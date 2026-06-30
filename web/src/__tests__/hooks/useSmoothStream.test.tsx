import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useSmoothStream } from '@/hooks/useSmoothStream'

// ---------------------------------------------------------------------------
// Deterministic rAF mock
// Instead of relying on real timers/wall-clock waits, we capture every
// callback registered via requestAnimationFrame and expose a `flushFrames`
// helper that runs them synchronously until none remain.
// ---------------------------------------------------------------------------

let pendingFrames: FrameRequestCallback[] = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRaf = mock((...args: any[]) => {
  const cb = args[0] as FrameRequestCallback
  pendingFrames.push(cb)
  return pendingFrames.length // fake frame id
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCancelRaf = mock((...args: any[]) => {
  const id = args[0] as number
  // Mark the slot as a no-op so it doesn't run when flushed.
  if (id > 0 && id <= pendingFrames.length) {
    pendingFrames[id - 1] = () => {}
  }
})

/** Run all queued rAF callbacks in order (simulates N animation frames). */
function flushFrames(count = 1) {
  for (let i = 0; i < count; i++) {
    const frames = pendingFrames.slice()
    pendingFrames = []
    frames.forEach((cb) => cb(performance.now()))
  }
}

beforeEach(() => {
  pendingFrames = []
  globalThis.requestAnimationFrame = mockRaf as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = mockCancelRaf as unknown as typeof cancelAnimationFrame
})

afterEach(() => {
  cleanup()
  pendingFrames = []
})

// ---------------------------------------------------------------------------

describe('useSmoothStream', () => {
  it('returns targetText immediately when isStreaming is false', () => {
    const { result } = renderHook(() => useSmoothStream('Hello, world!', false))
    expect(result.current).toBe('Hello, world!')
  })

  it('updates immediately when targetText changes and isStreaming is false', () => {
    let text = 'Hello'
    const { result, rerender } = renderHook(() => useSmoothStream(text, false))
    expect(result.current).toBe('Hello')

    text = 'Hello, world!'
    rerender()
    expect(result.current).toBe('Hello, world!')
  })

  it('animates text when isStreaming is true and targetText increases', () => {
    let text = 'Hello'
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))
    expect(result.current).toBe('Hello')

    text = 'Hello, world! This is a longer message.'
    rerender()

    // After one frame the text should have advanced but not be complete yet.
    act(() => { flushFrames(1) })
    expect(result.current.length).toBeGreaterThan('Hello'.length)
    expect(result.current.length).toBeLessThan(text.length)
    expect(result.current.startsWith('Hello')).toBe(true)

    // Flush enough frames to finish the animation (15% per frame converges fast).
    act(() => { flushFrames(40) })
    expect(result.current).toBe(text)
  })

  it('instantly snaps to targetText when isStreaming becomes false mid-animation', () => {
    let text = 'Hello'
    let streaming = true
    const { result, rerender } = renderHook(() => useSmoothStream(text, streaming))
    expect(result.current).toBe('Hello')

    text = 'Hello, world! This is a longer message.'
    rerender()

    // One frame in — still mid-animation.
    act(() => { flushFrames(1) })
    expect(result.current.length).toBeLessThan(text.length)

    // Turn off streaming — must snap immediately.
    streaming = false
    rerender()
    expect(result.current).toBe(text)
  })

  it('instantly resets if targetText is not an extension of displayedText', () => {
    let text = 'Hello'
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))
    expect(result.current).toBe('Hello')

    // Completely different text — must snap, no animation.
    text = 'Goodbye'
    rerender()
    expect(result.current).toBe('Goodbye')
  })

  it('cancels the previous rAF loop when targetText updates', () => {
    let text = 'Hello'
    const { rerender } = renderHook(() => useSmoothStream(text, true))

    text = 'Hello, world!'
    rerender()

    const framesBefore = pendingFrames.length

    // Updating again should cancel the old loop and schedule a fresh one.
    text = 'Hello, world! Extended.'
    rerender()

    // The pending queue should not grow unboundedly.
    expect(pendingFrames.length).toBeLessThanOrEqual(framesBefore + 1)
  })
})
