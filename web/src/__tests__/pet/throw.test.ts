/**
 * The pet thrown with the pointer: how fast the fling was when it let go,
 * whether that is a throw at all, and the path it flies along to where it lands.
 */
import { describe, expect, it } from 'bun:test'
import {
  GRAVITY,
  THROW_MAX_SPEED,
  THROW_MIN_SPEED,
  THROW_SAMPLE_MS,
  THROW_STALE_MS,
  TOP_ROOM,
  WALL_BOUNCE,
  isThrow,
  throwPath,
  throwVelocity,
  throwsAllowed,
  type Ledge,
} from '@/pet/state'

/** Pointer samples every 16 ms moving `dx`, `dy` px per sample, ending at `end` ms. */
const fling = (dx: number, dy: number, count = 8, end = 1000) =>
  Array.from({ length: count }, (_, i) => ({ x: 500 + dx * i, y: 500 + dy * i, t: end - (count - 1 - i) * 16 }))

describe('throwVelocity', () => {
  it('reads the speed of the last moments before the release, in px per second', () => {
    const v = throwVelocity(fling(16, -8), 1004)
    expect(v.vx).toBeCloseTo(1000, 5)
    expect(v.vy).toBeCloseTo(-500, 5)
  })

  it('looks only at the last THROW_SAMPLE_MS: a slow start does not water down a fast end', () => {
    const slow = Array.from({ length: 10 }, (_, i) => ({ x: 100 + i, y: 500, t: 200 + i * 16 }))
    const fast = fling(20, 0, 6, 1000).map((s) => ({ ...s, x: s.x + 1000 }))
    const v = throwVelocity([...slow, ...fast], 1000)
    expect(fast.at(-1)!.t - fast[0].t).toBeLessThanOrEqual(THROW_SAMPLE_MS)
    expect(v.vx).toBeCloseTo(1250, 5)
  })

  it('is nothing when the pointer stopped before it let go', () => {
    expect(throwVelocity(fling(30, 0), 1000 + THROW_STALE_MS + 1)).toEqual({ vx: 0, vy: 0 })
  })

  it('is nothing with too little to go on: no samples, one, or a few in the same instant', () => {
    expect(throwVelocity([], 1000)).toEqual({ vx: 0, vy: 0 })
    expect(throwVelocity([{ x: 0, y: 0, t: 1000 }], 1000)).toEqual({ vx: 0, vy: 0 })
    expect(throwVelocity([{ x: 0, y: 0, t: 1000 }, { x: 300, y: 0, t: 1000.5 }], 1001)).toEqual({ vx: 0, vy: 0 })
  })

  it('never goes faster than THROW_MAX_SPEED, keeping the direction', () => {
    const v = throwVelocity(fling(400, 300), 1000)
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(THROW_MAX_SPEED, 5)
    expect(v.vx / v.vy).toBeCloseTo(400 / 300, 5)
  })
})

describe('isThrow and throwsAllowed', () => {
  it('counts a fling from THROW_MIN_SPEED up as a throw; slower is a drop', () => {
    expect(isThrow({ vx: THROW_MIN_SPEED, vy: 0 })).toBe(true)
    expect(isThrow({ vx: 0, vy: -THROW_MIN_SPEED })).toBe(true)
    expect(isThrow({ vx: THROW_MIN_SPEED - 1, vy: 0 })).toBe(false)
    expect(isThrow({ vx: 0, vy: 0 })).toBe(false)
  })

  it('throws unless told to stay put or with reduced motion, climbing on or off', () => {
    expect(throwsAllowed({ movement: 'calm', reducedMotion: false })).toBe(true)
    expect(throwsAllowed({ movement: 'chaotic', reducedMotion: false })).toBe(true)
    expect(throwsAllowed({ movement: 'still', reducedMotion: false })).toBe(false)
    expect(throwsAllowed({ movement: 'playful', reducedMotion: true })).toBe(false)
  })
})

describe('throwPath', () => {
  const pet = { width: 64, height: 48 }
  const area = { width: 1440, height: 900 }
  const groundY = area.height - pet.height
  const path = (from: { x: number; y: number }, velocity: { vx: number; vy: number }, ledges: Ledge[] = []) =>
    throwPath({ from, velocity, area, pet, ledges, groundY })

  it('flies an arc under gravity and lands on the ground, farther along the way it was thrown', () => {
    const p = path({ x: 300, y: 400 }, { vx: 600, vy: -900 })
    expect(p.land).toEqual({ x: p.land.x, y: groundY, ledge: null })
    expect(p.land.x).toBeGreaterThan(300)
    // It rises first: the top of the arc is above where it was let go.
    expect(Math.min(...p.points.map((pt) => pt.y))).toBeLessThan(400)
    // Up and back to the same height, then on down to the ground: about 2 vy / g and a bit.
    expect(p.ms).toBeGreaterThan((2 * 900 * 1000) / GRAVITY)
    expect(p.ms).toBeLessThan(2000)
  })

  it('starts where it was let go and ends where it lands, in time order', () => {
    const p = path({ x: 300, y: 400 }, { vx: -500, vy: -300 })
    expect(p.points[0]).toEqual({ x: 300, y: 400, t: 0 })
    expect(p.points.at(-1)).toEqual({ x: p.land.x, y: p.land.y, t: p.ms })
    for (let i = 1; i < p.points.length; i += 1) expect(p.points[i].t).toBeGreaterThan(p.points[i - 1].t)
  })

  it('stays on the screen: it bounces off the sides, slower, and never goes above the top room', () => {
    const right = path({ x: 1200, y: 300 }, { vx: 2500, vy: -1500 })
    for (const pt of right.points) {
      expect(pt.x).toBeGreaterThanOrEqual(0)
      expect(pt.x).toBeLessThanOrEqual(area.width - pet.width)
      expect(pt.y).toBeGreaterThanOrEqual(TOP_ROOM)
      expect(pt.y).toBeLessThanOrEqual(groundY)
    }
    // Off the right edge it comes back left.
    expect(right.land.x).toBeLessThan(area.width - pet.width)
    const xs = right.points.map((pt) => pt.x)
    const turn = xs.indexOf(Math.max(...xs))
    expect(xs.at(-1)!).toBeLessThan(xs[turn])
    // And comes back slower, at WALL_BOUNCE of its speed.
    const [a, b] = [right.points[turn + 1], right.points[turn + 6]]
    expect(((a.x - b.x) / (b.t - a.t)) * 1000).toBeCloseTo(2500 * WALL_BOUNCE, 0)
  })

  it('lands on a window edge it comes down onto, not one it passes on the way up', () => {
    const ledge: Ledge = { id: 7, x: 200, y: 500, width: 600 }
    // Thrown up from below the edge, it passes it rising, then comes down onto it.
    const onto = path({ x: 400, y: 600 }, { vx: 100, vy: -1200 }, [ledge])
    expect(onto.land.ledge).toEqual(ledge)
    expect(onto.land.y).toBe(ledge.y - pet.height)
    // Thrown sideways from below it, it never gets above it: on to the ground.
    const under = path({ x: 400, y: 600 }, { vx: 600, vy: 0 }, [ledge])
    expect(under.land.ledge).toBeNull()
    expect(under.land.y).toBe(groundY)
  })

  it('lands only on an edge its middle comes down over', () => {
    const ledge: Ledge = { id: 7, x: 900, y: 500, width: 300 }
    const missed = path({ x: 300, y: 200 }, { vx: 0, vy: 0 }, [ledge])
    expect(missed.land.ledge).toBeNull()
  })

  it('thrown straight down, it lands at once on the ground below', () => {
    const p = path({ x: 300, y: 200 }, { vx: 0, vy: 2000 })
    expect(p.land).toEqual({ x: 300, y: groundY, ledge: null })
    expect(p.ms).toBeLessThan(400)
  })

  it('holds its whole path in its reach, the pet included', () => {
    const p = path({ x: 300, y: 400 }, { vx: 800, vy: -1200 })
    for (const pt of p.points) {
      expect(pt.x).toBeGreaterThanOrEqual(p.reach.x)
      expect(pt.y).toBeGreaterThanOrEqual(p.reach.y)
      expect(pt.x + pet.width).toBeLessThanOrEqual(p.reach.x + p.reach.width + 1e-9)
      expect(pt.y + pet.height).toBeLessThanOrEqual(p.reach.y + p.reach.height + 1e-9)
    }
  })
})
