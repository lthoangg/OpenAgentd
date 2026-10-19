import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { HANDOFF_ACTIVE_MS, useDraftHandoff } from '@/components/AgentChatView/useDraftHandoff'
import type { ComposerHandoff } from '@/components/FloatingInputComposer'

// Deterministic timers (Bun has no jest-style fake timer API); see ToastStack.test.tsx.
function useFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realDateNow = Date.now
  let now = 1_000_000
  let sequence = 0
  const timers = new Map<number, { callback: () => void; due: number }>()
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = ++sequence
    timers.set(id, { callback: callback as () => void, due: now + (delay ?? 0) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof clearTimeout
  Date.now = () => now
  return {
    tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      Date.now = realDateNow
    },
  }
}

const snapshot: ComposerHandoff = { rect: { left: 10, top: 300, width: 640, height: 96 }, focused: true }

type Props = { isDraft: boolean; sessionId?: string; reducedMotion: boolean }

function renderHandoff(initial: Props) {
  return renderHook((props: Props) => useDraftHandoff(props), { initialProps: initial })
}

let timers: ReturnType<typeof useFakeTimers> | null = null
afterEach(() => {
  cleanup()
  timers?.restore()
  timers = null
})

describe('useDraftHandoff', () => {
  it('hands the captured snapshot over when the first message ends the draft, then settles', () => {
    timers = useFakeTimers()
    const { result, rerender } = renderHandoff({ isDraft: true, reducedMotion: false })
    expect(result.current.active).toBe(false)

    result.current.capture(snapshot)
    rerender({ isDraft: false, reducedMotion: false })
    expect(result.current.active).toBe(true)
    expect(result.current.snapshot).toEqual(snapshot)

    act(() => timers!.tick(HANDOFF_ACTIVE_MS))
    expect(result.current.active).toBe(false)
    expect(result.current.snapshot).toBeNull()
  })

  it('is not a hand-off when the draft is left by opening a session', () => {
    const { result, rerender } = renderHandoff({ isDraft: true, reducedMotion: false })
    result.current.capture(snapshot)
    rerender({ isDraft: false, sessionId: 'other', reducedMotion: false })
    expect(result.current.active).toBe(false)
  })

  it('stays instant with reduced motion', () => {
    const { result, rerender } = renderHandoff({ isDraft: true, reducedMotion: true })
    result.current.capture(snapshot)
    rerender({ isDraft: false, reducedMotion: true })
    expect(result.current.active).toBe(false)
  })

  it('cross-fades without a glide when the snapshot is stale', () => {
    timers = useFakeTimers()
    const { result, rerender } = renderHandoff({ isDraft: true, reducedMotion: false })
    // e.g. a `/btw` sent from the draft, which does not leave it.
    result.current.capture(snapshot)
    act(() => timers!.tick(6_000))
    rerender({ isDraft: false, reducedMotion: false })
    expect(result.current.active).toBe(true)
    expect(result.current.snapshot).toBeNull()
  })
})
