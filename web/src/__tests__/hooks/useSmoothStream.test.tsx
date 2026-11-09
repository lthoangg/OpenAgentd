import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useSmoothStream, END_DRAIN_MS } from '@/hooks/useSmoothStream'

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

/**
 * Advance `count` frames the way the browser does — one `act` per frame, so
 * React commits each frame's state before the next callback runs. Flushing
 * many frames inside a single `act` batches every update to the end, which no
 * real rAF loop ever sees.
 */
function advanceFrames(count: number) {
  for (let i = 0; i < count; i++) act(() => { flushFrames(1) })
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

  it('keeps the rest flowing when the stream ends mid-reveal, instead of snapping', () => {
    let text = 'Hello'
    let streaming = true
    const { result, rerender } = renderHook(() => useSmoothStream(text, streaming))
    expect(result.current).toBe('Hello')

    // The last delta lands together with "done", as it usually does.
    text = 'Hello, world! This is a longer message.'
    rerender()
    advanceFrames(1)
    const shown = result.current.length
    expect(shown).toBeLessThan(text.length)

    streaming = false
    rerender()
    // Not in one frame: it picks up where it was.
    expect(result.current.length).toBe(shown)
    advanceFrames(1)
    expect(result.current.length).toBeGreaterThan(shown)
    expect(result.current.length).toBeLessThan(text.length)

    advanceFrames(60)
    expect(result.current).toBe(text)
  })

  it('shows the whole text at once when the end is too far behind to reveal', () => {
    let text = 'Hello'
    let streaming = true
    const { result, rerender } = renderHook(() => useSmoothStream(text, streaming))
    text = 'Hello' + 'x'.repeat(5000)
    streaming = false
    rerender()
    expect(result.current).toBe(text)
  })

  /**
   * The reveal after the stream ended took 15% of what was left per frame,
   * throttled on long answers: 0.5–1.7 s of a blinking caret after the answer
   * was complete. It now has a fixed time budget, however much is left.
   */
  it('finishes the rest within its time budget after the stream ends', () => {
    let text = 'Hello'
    let streaming = true
    const { result, rerender } = renderHook(() => useSmoothStream(text, streaming))
    text = 'Hello ' + 'word '.repeat(600)
    streaming = false
    rerender()

    const start = 1000
    let frame = 0
    while (result.current !== text && frame < 200) {
      const at = start + frame * 16.67
      act(() => {
        const frames = pendingFrames.slice()
        pendingFrames = []
        frames.forEach((cb) => cb(at))
      })
      frame++
    }
    expect(result.current).toBe(text)
    expect(frame * 16.67).toBeLessThanOrEqual(END_DRAIN_MS + 2 * 16.67)
    // It still flows rather than snapping on the first frame.
    expect(frame).toBeGreaterThan(3)
  })

  it('snaps at the end under reduced motion', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia
    try {
      let text = 'Hello'
      let streaming = true
      const { result, rerender } = renderHook(() => useSmoothStream(text, streaming))
      text = 'Hello, world! This is a longer message.'
      rerender()
      advanceFrames(1)
      streaming = false
      rerender()
      expect(result.current).toBe(text)
    } finally {
      window.matchMedia = original
    }
  })

  it('shows a later edit of a settled message at once', () => {
    let text = 'Hello'
    let streaming = true
    const { result, rerender } = renderHook(() => useSmoothStream(text, streaming))
    text = 'Hello, world!'
    rerender()
    streaming = false
    rerender()
    advanceFrames(60)
    expect(result.current).toBe('Hello, world!')

    text = 'Hello, world! Edited later.'
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

  /**
   * The loop used to re-arm itself every frame for as long as `isStreaming`
   * was true, even with nothing left to animate. A turn stays "streaming" for
   * its whole duration, so a multi-minute shell tool call kept one rAF loop
   * per text/thinking block alive for thousands of frames — pinning WebKit's
   * rendering pipeline at 60fps while the transcript sat still.
   */
  it('stops requesting frames once the displayed text has caught up', () => {
    let text = 'Hello'
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))

    text = 'Hello, world! This is a longer message.'
    rerender()

    advanceFrames(60)
    expect(result.current).toBe(text)

    // Caught up and still streaming: no further frames may be queued.
    expect(pendingFrames.length).toBe(0)
  })

  it('restarts the loop when new text arrives after catching up', () => {
    let text = 'Hello'
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))

    text = 'Hello, world!'
    rerender()
    advanceFrames(60)
    expect(result.current).toBe(text)

    text = 'Hello, world! And then some more text arrived.'
    rerender()
    expect(pendingFrames.length).toBeGreaterThan(0)

    advanceFrames(60)
    expect(result.current).toBe(text)
  })

  it('applies adaptive throttling when text is very long', () => {
    let text = 'A'.repeat(5500)
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))

    // Set a much longer target text
    text = 'A'.repeat(5500) + ' B'.repeat(100)
    rerender()

    // The length is > 5000, so throttleMs should be 75ms.
    // First frame at time 100
    act(() => {
      const cb = pendingFrames[pendingFrames.length - 1]
      if (cb) cb(100)
    })
    const lenAfterFirst = result.current.length

    // Second frame at time 150 (elapsed 50ms < 75ms)
    act(() => {
      const nextCb = pendingFrames[pendingFrames.length - 1]
      if (nextCb) nextCb(150)
    })
    // It should have throttled and NOT updated displayedText in this frame
    expect(result.current.length).toBe(lenAfterFirst)

    // Third frame at time 180 (elapsed 80ms >= 75ms since 100)
    act(() => {
      const nextCb = pendingFrames[pendingFrames.length - 1]
      if (nextCb) nextCb(180)
    })
    // It should now update
    expect(result.current.length).toBeGreaterThan(lenAfterFirst)
  })

  /**
   * Deltas land every ~16 ms, and each one re-ran the effect, which reset the
   * throttle clock — so the first frame after every delta re-rendered (and
   * re-parsed) the whole long message, whatever the throttle said.
   */
  it('keeps throttling when new text arrives between frames', () => {
    let text = 'A'.repeat(5500)
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))

    text = 'A'.repeat(5500) + ' B'.repeat(100)
    rerender()
    act(() => {
      pendingFrames[pendingFrames.length - 1]?.(100)
    })
    const lenAfterFirst = result.current.length

    // A new delta arrives 20 ms later, still inside the 75 ms window.
    text = text + ' C'.repeat(100)
    rerender()
    act(() => {
      pendingFrames[pendingFrames.length - 1]?.(120)
    })

    expect(result.current.length).toBe(lenAfterFirst)
  })
})
