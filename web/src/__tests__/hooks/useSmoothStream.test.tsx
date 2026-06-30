import { describe, it, expect, afterEach } from 'bun:test'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useSmoothStream } from '@/hooks/useSmoothStream'

afterEach(cleanup)

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

  it('animates text when isStreaming is true and targetText increases', async () => {
    let text = 'Hello'
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))
    expect(result.current).toBe('Hello')

    // Increase targetText
    text = 'Hello, world! This is a longer message.'
    rerender()

    // It should not jump to the full text immediately
    expect(result.current.length).toBeLessThan(text.length)
    expect(result.current.startsWith('Hello')).toBe(true)

    // Wait a few animation frames
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    // It should have progressed
    expect(result.current.length).toBeGreaterThan(5)

    // Wait enough time for it to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    expect(result.current).toBe(text)
  })

  it('instantly snaps to targetText when isStreaming becomes false mid-animation', () => {
    let text = 'Hello'
    let streaming = true
    const { result, rerender } = renderHook(() => useSmoothStream(text, streaming))
    expect(result.current).toBe('Hello')

    text = 'Hello, world! This is a longer message.'
    rerender()
    expect(result.current.length).toBeLessThan(text.length)

    // Turn off streaming
    streaming = false
    rerender()
    expect(result.current).toBe(text)
  })

  it('instantly resets if targetText is not an extension of displayedText', () => {
    let text = 'Hello'
    const { result, rerender } = renderHook(() => useSmoothStream(text, true))
    expect(result.current).toBe('Hello')

    // Completely different text
    text = 'Goodbye'
    rerender()
    expect(result.current).toBe('Goodbye')
  })
})
