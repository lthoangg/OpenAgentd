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

describe('useLongPress (shared core)', () => {
  it('reports pressing=true on pointer down and pressing=false on long-press fire', async () => {
    const pressStates: boolean[] = []
    const onLongPress = mock(() => {})
    render(
      <Surface enabled onLongPress={onLongPress} onPressChange={(p) => pressStates.push(p)} />,
    )
    fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
    expect(pressStates).toEqual([true])
    await new Promise((r) => setTimeout(r, 600))
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(pressStates).toEqual([true, false])
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

  it('works with no onPressChange callback supplied (optional)', async () => {
    const onLongPress = mock(() => {})
    render(<Surface enabled onLongPress={onLongPress} />)
    fireEvent.pointerDown(screen.getByTestId('surface'), pressOpts())
    await new Promise((r) => setTimeout(r, 600))
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })
})
