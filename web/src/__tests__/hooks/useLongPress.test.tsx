import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { useLongPress } from '@/hooks/use-long-press'

function Surface({
  enabled,
  onLongPress,
  onPressChange,
}: {
  enabled: boolean
  onLongPress: () => void
  onPressChange?: (pressing: boolean) => void
}) {
  const handlers = useLongPress(enabled, onLongPress, onPressChange)
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

describe('useLongPress (shared core)', () => {
  it('reports pressing=true on pointer down and pressing=false on long-press fire', () => {
    const fakeTimers = useFakeTimers()
    try {
      const pressStates: boolean[] = []
      const onLongPress = mock(() => {})
      render(
        <Surface enabled onLongPress={onLongPress} onPressChange={(p) => pressStates.push(p)} />,
      )
      fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
      expect(pressStates).toEqual([true])
      fakeTimers.tick(600)
      expect(onLongPress).toHaveBeenCalledTimes(1)
      expect(pressStates).toEqual([true, false])
    } finally {
      fakeTimers.restore()
    }
  })

  it('reports pressing=false when cancelled by pointer-up before threshold', () => {
    const pressStates: boolean[] = []
    render(
      <Surface enabled onLongPress={() => {}} onPressChange={(p) => pressStates.push(p)} />,
    )
    const surface = screen.getByTestId('surface')
    fireEvent.pointerDown(surface, pressOpts())
    fireEvent.pointerUp(surface, pressOpts())
    expect(pressStates).toEqual([true, false])
  })

  it('works with no onPressChange callback supplied (optional)', () => {
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

  it('swallows the click a held release raises on the sheet it opened, but not a new tap there', () => {
    const fakeTimers = useFakeTimers()
    try {
      const onRow = mock(() => {})
      render(
        <>
          <Surface enabled onLongPress={() => {}} />
          <button type="button" onClick={onRow}>Create worktree…</button>
        </>,
      )
      const surface = screen.getByTestId('surface')
      fireEvent.pointerDown(surface, pressOpts())
      fakeTimers.tick(600)
      fireEvent.pointerUp(surface, pressOpts())
      // The release's click lands on the row the sheet put under the finger.
      fireEvent.click(screen.getByText('Create worktree…'))
      expect(onRow).not.toHaveBeenCalled()

      fireEvent.pointerDown(screen.getByText('Create worktree…'), pressOpts())
      fireEvent.click(screen.getByText('Create worktree…'))
      expect(onRow).toHaveBeenCalledTimes(1)
    } finally {
      fakeTimers.restore()
    }
  })

  it('lets the click of a short tap through', () => {
    const onRow = mock(() => {})
    render(
      <>
        <Surface enabled onLongPress={() => {}} />
        <button type="button" onClick={onRow}>Row</button>
      </>,
    )
    fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
    fireEvent.pointerUp(screen.getByTestId('surface'), pressOpts())
    fireEvent.click(screen.getByText('Row'))
    expect(onRow).toHaveBeenCalledTimes(1)
  })
})
