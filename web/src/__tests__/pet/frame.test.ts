/**
 * The pet's window is a lane of the work area, not all of it: what the page
 * asks for, when it grows and shrinks, and how window-local points become
 * area points (the pixels everything else is in).
 */
import { describe, expect, it } from 'bun:test'
import {
  BUBBLE_ROOM,
  FRAME_ABOVE,
  FRAME_BELOW,
  FRAME_SHRINK_MIN,
  frameCovers,
  fullFrame,
  growFrame,
  laneFrame,
  neededFrame,
  originMoves,
  shrinkable,
  toArea,
  type Box,
} from '@/pet/state'

const area = { width: 1440, height: 800 }
const pet = (y = 752): Box => ({ x: 300, y, width: 64, height: 48 })

describe('toArea', () => {
  it('adds the window origin to a window-local box', () => {
    expect(toArea({ x: 10, y: 20, width: 64, height: 48 }, { x: 0, y: 696 })).toEqual({ x: 10, y: 716, width: 64, height: 48 })
    expect(toArea({ x: -30, y: 5, width: 4, height: 4 }, { x: 100, y: 0 })).toEqual({ x: 70, y: 5, width: 4, height: 4 })
  })
})

describe('laneFrame', () => {
  it('is the full width, from the top to the bottom asked for', () => {
    expect(laneFrame(696, 800, area)).toEqual({ x: 0, y: 696, width: 1440, height: 104 })
  })

  it('stays inside the area and is never empty', () => {
    expect(laneFrame(-50, 5000, area)).toEqual(fullFrame(area))
    const sliver = laneFrame(900, 950, area)
    expect(sliver.height).toBeGreaterThanOrEqual(1)
    expect(sliver.y + sliver.height).toBeLessThanOrEqual(800)
  })

  it('uses whole pixels', () => {
    const lane = laneFrame(100.4, 200.6, area)
    expect(Number.isInteger(lane.y) && Number.isInteger(lane.height)).toBe(true)
    expect(lane.y).toBeLessThanOrEqual(100.4)
    expect(lane.y + lane.height).toBeGreaterThanOrEqual(200.6)
  })
})

describe('neededFrame', () => {
  const need = (patch: Partial<Parameters<typeof neededFrame>[0]> = {}) =>
    neededFrame({ area, pet: pet(), reach: null, rects: [], dragging: false, ...patch })

  it('is a thin lane round a pet on the ground: room for its marks above and its feet below', () => {
    expect(need()).toEqual({ x: 0, y: 752 - FRAME_ABOVE, width: 1440, height: FRAME_ABOVE + 48 })
    // Far smaller than the work area.
    expect(need().height).toBeLessThan(area.height / 5)
  })

  it('follows the pet to where it stands higher up, with room for its feet', () => {
    expect(need({ pet: pet(300) })).toEqual({ x: 0, y: 300 - FRAME_ABOVE, width: 1440, height: FRAME_ABOVE + 48 + FRAME_BELOW })
  })

  it('is the whole area while it is dragged', () => {
    expect(need({ dragging: true })).toEqual(fullFrame(area))
  })

  it('covers a bubble above the pet, and one below it', () => {
    const above = { x: 288, y: 752 - 16 - BUBBLE_ROOM, width: 290, height: BUBBLE_ROOM }
    expect(need({ rects: [above] }).y).toBe(above.y)
    const near = pet(40)
    const below = { x: 288, y: 40 + 48 + 16, width: 290, height: 150 }
    const lane = need({ pet: near, rects: [below] })
    expect(lane.y).toBe(0)
    expect(lane.y + lane.height).toBe(below.y + below.height)
  })

  it('covers a ladder, a balloon and the whole path of a move', () => {
    const ladder = { x: 321, y: 394, width: 22, height: 406 }
    expect(need({ rects: [ladder] }).y).toBe(394)
    const path = { x: 300, y: 300, width: 64, height: 500 }
    const lane = need({ reach: path })
    expect(lane.y).toBe(300 - FRAME_ABOVE)
    expect(lane.y + lane.height).toBe(800)
  })

  it('stops at the edges of the area', () => {
    const lane = need({ pet: pet(0) })
    expect(lane.y).toBe(0)
    expect(need({ pet: pet(752) }).y + need({ pet: pet(752) }).height).toBe(800)
  })
})

describe('growing and shrinking the frame', () => {
  const low = laneFrame(696, 800, area)
  const high = laneFrame(300, 420, area)

  it('knows what a frame covers', () => {
    expect(frameCovers(low, laneFrame(700, 790, area))).toBe(true)
    expect(frameCovers(low, laneFrame(300, 420, area))).toBe(false)
    // Within a pixel is covered.
    expect(frameCovers(low, { x: 0, y: 695.5, width: 1440, height: 105 })).toBe(true)
  })

  it('grows at once to hold both the frame it has and what is needed', () => {
    const both = growFrame(low, high)
    expect(both).toEqual({ x: 0, y: 300, width: 1440, height: 500 })
    expect(frameCovers(both, low) && frameCovers(both, high)).toBe(true)
  })

  it('shrinks only when what is needed is well inside the frame', () => {
    const both = growFrame(low, high)
    expect(shrinkable(both, low)).toBe(true)
    expect(shrinkable(both, high)).toBe(true)
    // Not when it is not covered, nor for a few pixels.
    expect(shrinkable(low, high)).toBe(false)
    expect(shrinkable(low, { ...low, y: low.y + FRAME_SHRINK_MIN - 1, height: low.height - FRAME_SHRINK_MIN + 1 })).toBe(false)
    expect(shrinkable(low, low)).toBe(false)
  })

  it('says when the top-left corner moves (the content must be hidden for it)', () => {
    expect(originMoves(low, high)).toBe(true)
    // Only the bottom edge or the right edge moves: nothing shifts.
    expect(originMoves(low, { ...low, height: low.height - 30 })).toBe(false)
    expect(originMoves(low, { ...low, width: 1000 })).toBe(false)
    expect(originMoves(low, { ...low, x: 40 })).toBe(true)
  })
})
