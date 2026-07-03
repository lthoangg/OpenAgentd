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

describe('useLongPressSurface', () => {
  it('fires onLongPress after the hold threshold', async () => {
    const onLongPress = mock(() => {})
    render(<Surface enabled onLongPress={onLongPress} />)
    fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
    await new Promise((r) => setTimeout(r, 600))
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('does not fire for mouse pointers', async () => {
    const onLongPress = mock(() => {})
    render(<Surface enabled onLongPress={onLongPress} />)
    fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts({ pointerType: 'mouse' }))
    await new Promise((r) => setTimeout(r, 600))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('does not fire when disabled', async () => {
    const onLongPress = mock(() => {})
    render(<Surface enabled={false} onLongPress={onLongPress} />)
    fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
    await new Promise((r) => setTimeout(r, 600))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels when the pointer moves beyond tolerance', async () => {
    const onLongPress = mock(() => {})
    render(<Surface enabled onLongPress={onLongPress} />)
    const surface = screen.getByTestId('surface')
    fireEvent.pointerDown(surface, pressOpts())
    fireEvent.pointerMove(surface, pressOpts({ clientY: 80 }))
    await new Promise((r) => setTimeout(r, 600))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels on pointer up before the threshold', async () => {
    const onLongPress = mock(() => {})
    render(<Surface enabled onLongPress={onLongPress} />)
    const surface = screen.getByTestId('surface')
    fireEvent.pointerDown(surface, pressOpts())
    fireEvent.pointerUp(surface, pressOpts())
    await new Promise((r) => setTimeout(r, 600))
    expect(onLongPress).not.toHaveBeenCalled()
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
