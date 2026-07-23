import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { useLongPressSurface } from '@/components/Terminal/use-long-press-surface'

function Surface({ enabled, onLongPress }: { enabled: boolean; onLongPress: () => void }) {
  const handlers = useLongPressSurface(enabled, onLongPress)
  return <div data-testid="surface" {...handlers} />
}

function pressOpts(extra?: Record<string, unknown>) {
  return { pointerType: 'touch', clientX: 50, clientY: 50, ...extra }
}

function useFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let now = 0
  let sequence = 0
  const timers = new Map<number, { callback: () => void; due: number }>()

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = ++sequence
    timers.set(id, { callback: callback as () => void, due: now + (delay ?? 0) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof clearTimeout

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
    },
  }
}

describe('useLongPressSurface', () => {
  it('fires onLongPress after the hold threshold', () => {
    const fakeTimers = useFakeTimers()
    try {
      const onLongPress = mock(() => {})
      render(<Surface enabled onLongPress={onLongPress} />)
      fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
      fakeTimers.tick(600)
      expect(onLongPress).toHaveBeenCalledTimes(1)
    } finally {
      fakeTimers.restore()
    }
  })

  it('does not fire for mouse pointers', () => {
    const fakeTimers = useFakeTimers()
    try {
      const onLongPress = mock(() => {})
      render(<Surface enabled onLongPress={onLongPress} />)
      fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts({ pointerType: 'mouse' }))
      fakeTimers.tick(600)
      expect(onLongPress).not.toHaveBeenCalled()
    } finally {
      fakeTimers.restore()
    }
  })

  it('does not fire when disabled', () => {
    const fakeTimers = useFakeTimers()
    try {
      const onLongPress = mock(() => {})
      render(<Surface enabled={false} onLongPress={onLongPress} />)
      fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
      fakeTimers.tick(600)
      expect(onLongPress).not.toHaveBeenCalled()
    } finally {
      fakeTimers.restore()
    }
  })

  it('cancels when the pointer moves beyond tolerance', () => {
    const fakeTimers = useFakeTimers()
    try {
      const onLongPress = mock(() => {})
      render(<Surface enabled onLongPress={onLongPress} />)
      const surface = screen.getByTestId('surface')
      fireEvent.pointerDown(surface, pressOpts())
      fireEvent.pointerMove(surface, pressOpts({ clientY: 80 }))
      fakeTimers.tick(600)
      expect(onLongPress).not.toHaveBeenCalled()
    } finally {
      fakeTimers.restore()
    }
  })

  it('cancels on pointer up before the threshold', () => {
    const fakeTimers = useFakeTimers()
    try {
      const onLongPress = mock(() => {})
      render(<Surface enabled onLongPress={onLongPress} />)
      const surface = screen.getByTestId('surface')
      fireEvent.pointerDown(surface, pressOpts())
      fireEvent.pointerUp(surface, pressOpts())
      fakeTimers.tick(600)
      expect(onLongPress).not.toHaveBeenCalled()
    } finally {
      fakeTimers.restore()
    }
  })

  it('suppresses the native context menu only when enabled', () => {
    const onLongPress = mock(() => {})
    const { rerender } = render(<Surface enabled onLongPress={onLongPress} />)
    const enabledEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByTestId('surface').dispatchEvent(enabledEvent)
    expect(enabledEvent.defaultPrevented).toBe(true)

    rerender(<Surface enabled={false} onLongPress={onLongPress} />)
    const disabledEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByTestId('surface').dispatchEvent(disabledEvent)
    expect(disabledEvent.defaultPrevented).toBe(false)
  })
})
