import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { useToggleTween } from '@/hooks/useToggleTween'
import { useFakeTimers } from '../fake-timers'

let timers: ReturnType<typeof useFakeTimers> | null = null
afterEach(() => {
  cleanup()
  timers?.restore()
  timers = null
})

const seen: boolean[] = []
function Probe({ open }: { open: boolean }) {
  seen.push(useToggleTween(open, 240))
  return null
}

describe('useToggleTween', () => {
  it('is still at mount, so a panel that starts open does not slide in', () => {
    seen.length = 0
    render(<Probe open />)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((running) => !running)).toBe(true)
  })

  it('runs from the very render that flips open, then settles after the tween', () => {
    seen.length = 0
    const view = render(<Probe open />)
    timers = useFakeTimers()
    seen.length = 0
    act(() => view.rerender(<Probe open={false} />))
    // The width change and its transition must land in the same commit.
    expect(seen.at(-1)).toBe(true)
    act(() => timers!.tick(239))
    expect(seen.at(-1)).toBe(true)
    act(() => timers!.tick(1))
    expect(seen.at(-1)).toBe(false)
  })
})
