import { describe, expect, it, mock } from 'bun:test'

import {
  cellHeight,
  lineAccumulator,
  scrollTerminal,
  startMomentum,
  type ScrollableTerminal,
} from '@/components/Terminal/terminal-touch-scroll'

function fakeTerm(overrides: Partial<ScrollableTerminal> = {}): ScrollableTerminal & { wheels: WheelEvent[] } {
  const element = document.createElement('div')
  const wheels: WheelEvent[] = []
  element.addEventListener('wheel', (event) => wheels.push(event as WheelEvent))
  return {
    element,
    rows: 24,
    options: { fontSize: 10 },
    buffer: { active: { type: 'normal' } },
    modes: { mouseTrackingMode: 'none' },
    scrollLines: mock(() => {}),
    wheels,
    ...overrides,
  }
}

describe('lineAccumulator', () => {
  it('turns travel into whole lines, carrying the rest; down is back (negative)', () => {
    const lines = lineAccumulator(() => 10)
    expect(lines(25)).toBe(-2)
    expect(lines(6)).toBe(-1)
    expect(lines(-12)).toBe(1)
  })
})

describe('cellHeight', () => {
  it('falls back to the font size when the screen has not been measured', () => {
    expect(cellHeight(fakeTerm())).toBe(12)
  })
})

describe('scrollTerminal', () => {
  it('moves the scrollback in the normal buffer', () => {
    const term = fakeTerm()
    scrollTerminal(term, -3, { x: 0, y: 0 })
    expect(term.scrollLines).toHaveBeenCalledWith(-3)
    expect(term.wheels).toHaveLength(0)
  })

  it('sends one line wheel per line to a full-screen program or one that asked for the mouse', () => {
    for (const term of [
      fakeTerm({ buffer: { active: { type: 'alternate' } } }),
      fakeTerm({ modes: { mouseTrackingMode: 'vt200' } }),
    ]) {
      scrollTerminal(term, -2, { x: 5, y: 6 })
      expect(term.scrollLines).not.toHaveBeenCalled()
      // Happy DOM's WheelEvent drops clientX/clientY, so the position is not checked here.
      expect(term.wheels.map((event) => [event.deltaY, event.deltaMode, event.bubbles])).toEqual([
        [-1, WheelEvent.DOM_DELTA_LINE, true],
        [-1, WheelEvent.DOM_DELTA_LINE, true],
      ])
    }
  })

  it('does nothing for no lines', () => {
    const term = fakeTerm()
    scrollTerminal(term, 0, { x: 0, y: 0 })
    expect(term.scrollLines).not.toHaveBeenCalled()
  })
})

describe('startMomentum', () => {
  function frames() {
    const queue: Array<(time: number) => void> = []
    return {
      raf: (callback: (time: number) => void) => queue.push(callback),
      cancel: () => { queue.length = 0 },
      run(times: number) {
        for (let i = 1; i <= times && queue.length; i++) queue.shift()!(i * 16)
      },
      get pending() { return queue.length },
    }
  }

  it('keeps travelling the way the fling went, slowing until it stops', () => {
    const clock = frames()
    const travel: number[] = []
    startMomentum(1, (px) => travel.push(px), clock.raf, clock.cancel)
    clock.run(500)
    expect(travel[0]).toBeCloseTo(16)
    expect(travel.every((px, i) => i === 0 || px <= travel[i - 1]!)).toBe(true)
    expect(clock.pending).toBe(0)
  })

  it('a slow release does not fling, and a new touch stops one', () => {
    const clock = frames()
    startMomentum(0.01, () => {}, clock.raf, clock.cancel)
    expect(clock.pending).toBe(0)
    const stop = startMomentum(2, () => {}, clock.raf, clock.cancel)
    stop()
    expect(clock.pending).toBe(0)
  })
})
