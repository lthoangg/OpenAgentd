import { describe, expect, it } from 'bun:test'

import {
  arrowStep,
  isDoubleTap,
  pinchFont,
  TOUCH_IDLE,
  terminalTouchMachine,
  type TouchGesture,
  type TouchGestureEvent,
} from '@/components/Terminal/terminal-touch-state'

const run = (events: TouchGestureEvent[], from: TouchGesture = TOUCH_IDLE) =>
  events.reduce((state, event) => terminalTouchMachine.transition(state, event), from)

const down = { type: 'down', x: 100, y: 100, t: 0 } as const

describe('terminal touch machine', () => {
  it('a press that moves past the tolerance before the hold scrolls', () => {
    expect(run([down, { type: 'move', x: 104, y: 105, t: 10 }]).kind).toBe('pressed')
    expect(run([down, { type: 'move', x: 100, y: 120, t: 20 }]).kind).toBe('scrolling')
  })

  it('a press held still is held; released there it is idle again (the menu)', () => {
    expect(run([down, { type: 'hold' }]).kind).toBe('held')
    expect(run([down, { type: 'hold' }, { type: 'up' }]).kind).toBe('idle')
  })

  it('a held finger that moves drives the arrows, measured from where the hold began', () => {
    const state = run([down, { type: 'hold' }, { type: 'move', x: 100, y: 150, t: 700 }])
    expect(state).toEqual({ kind: 'arrows', x0: 100, y0: 100, dx: 0, dy: 50 })
  })

  it('scrolling keeps a smoothed velocity in px per ms', () => {
    const state = run([down, { type: 'move', x: 100, y: 120, t: 20 }, { type: 'move', x: 100, y: 140, t: 30 }])
    expect(state.kind).toBe('scrolling')
    if (state.kind === 'scrolling') expect(state.velocity).toBeCloseTo(1.6)
  })

  it('a second finger pinches from a press, a scroll or a hold, but not while arrows repeat', () => {
    const pinch = { type: 'pinch', distance: 100, font: 13 } as const
    expect(run([down, pinch]).kind).toBe('pinching')
    expect(run([down, { type: 'move', x: 100, y: 130, t: 5 }, pinch]).kind).toBe('pinching')
    expect(run([down, { type: 'hold' }, pinch]).kind).toBe('pinching')
    expect(run([down, { type: 'hold' }, { type: 'move', x: 160, y: 100, t: 9 }, pinch]).kind).toBe('arrows')
  })

  it('a spread scales the size from where the pinch began', () => {
    const state = run([down, { type: 'pinch', distance: 100, font: 13 }, { type: 'spread', distance: 200 }])
    expect(state).toMatchObject({ kind: 'pinching', font: 20 })
  })

  it('a hold timer that fires after the finger lifted changes nothing', () => {
    expect(run([{ type: 'hold' }])).toBe(TOUCH_IDLE)
  })

  it('a move with nothing pressed is a bug', () => {
    expect(() => terminalTouchMachine.transition(TOUCH_IDLE, { type: 'move', x: 0, y: 0, t: 0 })).toThrow()
  })
})

describe('arrowStep', () => {
  it('sends nothing within the tolerance', () => {
    expect(arrowStep(4, -6)).toBeNull()
  })

  it('follows the axis the finger moved most', () => {
    expect(arrowStep(-40, 12)?.key).toBe('left')
    expect(arrowStep(40, 12)?.key).toBe('right')
    expect(arrowStep(5, -20)?.key).toBe('up')
    expect(arrowStep(5, 20)?.key).toBe('down')
  })

  it('repeats faster the farther the finger goes: three gears', () => {
    expect(arrowStep(0, 20)?.interval).toBe(300)
    expect(arrowStep(0, 50)?.interval).toBe(120)
    expect(arrowStep(0, 120)?.interval).toBe(50)
  })
})

describe('pinchFont', () => {
  it('rounds to whole px within 10 to 20', () => {
    expect(pinchFont(13, 1.1)).toBe(14)
    expect(pinchFont(13, 0.1)).toBe(10)
    expect(pinchFont(13, 4)).toBe(20)
  })
})

describe('isDoubleTap', () => {
  it('needs the same place and under 300ms', () => {
    const first = { x: 10, y: 10, t: 0 }
    expect(isDoubleTap(null, first)).toBe(false)
    expect(isDoubleTap(first, { x: 20, y: 15, t: 250 })).toBe(true)
    expect(isDoubleTap(first, { x: 10, y: 10, t: 301 })).toBe(false)
    expect(isDoubleTap(first, { x: 40, y: 10, t: 100 })).toBe(false)
  })
})
