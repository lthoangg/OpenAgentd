import { afterEach, describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const hapticCalls: string[] = []

mock.module('@/lib/haptics', () => ({
  softHapticFeedback: () => hapticCalls.push('soft'),
  mediumHapticFeedback: () => hapticCalls.push('medium'),
}))

import { LongPressButton } from '@/components/ui/long-press-button'

afterEach(() => {
  hapticCalls.length = 0
})

function pressOpts(extra?: Record<string, unknown>) {
  return { pointerType: 'touch', clientX: 50, clientY: 50, ...extra }
}

describe('LongPressButton', () => {
  it('marks the button as pressing while a touch press is armed', () => {
    render(
      <LongPressButton enabled onLongPress={() => {}}>
        Session
      </LongPressButton>,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button, pressOpts())
    expect(button.dataset.pressing).toBe('true')

    fireEvent.pointerUp(button, pressOpts())
    expect(button.dataset.pressing).toBeUndefined()
  })

  it('does not arm for mouse pointers', () => {
    render(
      <LongPressButton enabled onLongPress={() => {}}>
        Session
      </LongPressButton>,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button, pressOpts({ pointerType: 'mouse' }))
    expect(button.dataset.pressing).toBeUndefined()
  })

  it('does not arm when disabled', () => {
    render(
      <LongPressButton enabled={false} onLongPress={() => {}}>
        Session
      </LongPressButton>,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button, pressOpts())
    expect(button.dataset.pressing).toBeUndefined()
  })

  it('cancels the press when the pointer moves beyond tolerance', () => {
    const onLongPress = mock(() => {})
    render(
      <LongPressButton enabled onLongPress={onLongPress}>
        Session
      </LongPressButton>,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button, pressOpts())
    fireEvent.pointerMove(button, pressOpts({ clientY: 80 }))
    expect(button.dataset.pressing).toBeUndefined()
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('replaces a stale armed press when a new touch starts', () => {
    const originalClearTimeout = window.clearTimeout
    const clearTimeout = mock((...args: unknown[]) => originalClearTimeout(args[0] as number | undefined))
    window.clearTimeout = clearTimeout as typeof window.clearTimeout

    try {
      render(
        <LongPressButton enabled onLongPress={() => {}}>
          Session
        </LongPressButton>,
      )
      const button = screen.getByRole('button')

      fireEvent.pointerDown(button, pressOpts())
      fireEvent.pointerDown(button, pressOpts({ clientX: 60 }))

      expect(clearTimeout).toHaveBeenCalledTimes(1)
      expect(button.dataset.pressing).toBe('true')
    } finally {
      window.clearTimeout = originalClearTimeout
    }
  })

  it('fires onLongPress with a medium haptic after the hold threshold', async () => {
    const onLongPress = mock(() => {})
    render(
      <LongPressButton enabled onLongPress={onLongPress}>
        Session
      </LongPressButton>,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button, pressOpts())
    await waitFor(() => expect(onLongPress).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    })

    expect(hapticCalls).toEqual(['medium'])
    expect(button.dataset.pressing).toBeUndefined()
  })

  it('cancels an armed touch press when unmounted', async () => {
    const onLongPress = mock(() => {})
    const view = render(
      <LongPressButton enabled onLongPress={onLongPress}>
        Session
      </LongPressButton>,
    )
    const button = screen.getByRole('button')

    fireEvent.pointerDown(button, pressOpts())
    view.unmount()

    await new Promise((resolve) => window.setTimeout(resolve, 650))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('keeps the scale-press affordance classes on the button', () => {
    render(
      <LongPressButton enabled onLongPress={() => {}} className="custom">
        Session
      </LongPressButton>,
    )
    const button = screen.getByRole('button')

    expect(button.className).toContain('data-pressing:scale-[0.97]')
    expect(button.className).toContain('custom')
  })
})
