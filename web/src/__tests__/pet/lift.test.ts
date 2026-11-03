/**
 * The pet changes height with a jump or a fall: what it picks, when it may,
 * where it goes and lands, and how long each takes.
 */
import { describe, expect, it } from 'bun:test'
import {
  CLIMB_CHANCE,
  FALL_MAX_SPEED,
  GRAVITY,
  JUMP_DOWN_CHANCE,
  JUMP_CLEAR,
  JUMP_CROUCH_MS,
  JUMP_HOP,
  JUMP_LOOK_MS,
  JUMP_MAX_MS,
  JUMP_MIN_MS,
  JUMP_STEPS,
  chooseLift,
  dropFalls,
  fallCapped,
  fallMs,
  fallTarget,
  jumpApexY,
  jumpMs,
  jumpPath,
  jumpReach,
  liftsAllowed,
  petPose,
  type LiftContext,
  type PoseInput,
} from '@/pet/state'

describe('petPose while changing height', () => {
  const base: PoseInput = {
    status: { running: 0, needsInput: 0 },
    reaction: null,
    sitting: true,
    idleMs: 0,
    reducedMotion: false,
    movement: 'playful',
  }

  it('takes the pose of the move, over a poke and over being held', () => {
    expect(petPose({ ...base, lift: 'fall' })).toBe('fall')
    expect(petPose({ ...base, lift: 'fall', reaction: 'hop', held: true })).toBe('fall')
    expect(petPose({ ...base, lift: 'sit', sitting: false })).toBe('sit')
  })

  it('still raises the alert for a waiting question, and never moves when told not to', () => {
    expect(petPose({ ...base, lift: 'fall', status: { running: 0, needsInput: 1 } })).toBe('alert')
    expect(petPose({ ...base, lift: 'fall', movement: 'still' })).toBe('sit')
    expect(petPose({ ...base, lift: 'fall', reducedMotion: true })).toBe('sit')
  })
})

describe('changing height', () => {
  const pet = { width: 64, height: 48 }
  const area = { width: 1440, height: 900 }
  const ground = 900 - 48
  /** A window edge whose pet stands `rise` px above the ground. */
  const ledgeRising = (rise: number, id = 1, x = 100, width = 600) => ({ id, x, y: ground - rise + pet.height, width })
  const ctx = (patch: Partial<LiftContext> = {}): LiftContext => ({
    movement: 'playful',
    climb: true,
    reducedMotion: false,
    held: false,
    perched: false,
    x: 300,
    y: ground,
    ledges: [],
    pet,
    area,
    ...patch,
  })
  /** A `random` that gives these values in turn, then repeats the last. */
  const roll = (...values: number[]) => {
    let i = 0
    return () => values[Math.min(i++, values.length - 1)]
  }

  describe('chooseLift', () => {
    it('jumps to a window edge of any height, tall ones included', () => {
      expect(chooseLift(ctx({ ledges: [ledgeRising(90)] }), roll(0))).toEqual({ type: 'jump', ledge: ledgeRising(90) })
      expect(chooseLift(ctx({ ledges: [ledgeRising(96)] }), roll(0))).toEqual({ type: 'jump', ledge: ledgeRising(96) })
      expect(chooseLift(ctx({ ledges: [ledgeRising(97)] }), roll(0))).toEqual({ type: 'jump', ledge: ledgeRising(97) })
      expect(chooseLift(ctx({ ledges: [ledgeRising(400)] }), roll(0))).toEqual({ type: 'jump', ledge: ledgeRising(400) })
    })

    it('takes the window edge nearest to it, and ignores one below it', () => {
      const far = ledgeRising(300, 2, 900, 400)
      const near = ledgeRising(250, 1, 200, 400)
      expect(chooseLift(ctx({ ledges: [far, near] }), roll(0))).toEqual({ type: 'jump', ledge: near })
      expect(chooseLift(ctx({ ledges: [ledgeRising(-100)] }), roll(0.99))).toEqual({ type: 'stay' })
    })

    it('jumps down from a window of any height', () => {
      const down = (rise: number, patch: Partial<LiftContext> = {}) =>
        chooseLift(ctx({ perched: true, y: ground - rise, ledges: [ledgeRising(rise)], ...patch }), roll(0))
      expect(down(400)).toEqual({ type: 'jump', ledge: null })
      expect(down(96)).toEqual({ type: 'jump', ledge: null })
    })

    it('uses the same chance up and down at any height: CLIMB_CHANCE up, JUMP_DOWN_CHANCE down', () => {
      for (const rise of [60, 400]) {
        const ledges = [ledgeRising(rise)]
        expect(chooseLift(ctx({ ledges }), roll(CLIMB_CHANCE - 0.001)).type).toBe('jump')
        expect(chooseLift(ctx({ ledges }), roll(CLIMB_CHANCE + 0.001)).type).toBe('stay')
        const standing = ctx({ perched: true, y: ground - rise, ledges })
        expect(chooseLift(standing, roll(JUMP_DOWN_CHANCE - 0.001)).type).toBe('jump')
        expect(chooseLift(standing, roll(JUMP_DOWN_CHANCE + 0.001)).type).toBe('stay')
      }
    })

    it('only ever stays or jumps, whatever the roll', () => {
      const tall = [ledgeRising(400)]
      const low = [ledgeRising(60)]
      for (const movement of ['still', 'calm', 'playful', 'chaotic'] as const) {
        for (const ledges of [[], tall, low]) {
          for (let i = 0; i < 200; i += 1) {
            const choice = chooseLift(ctx({ movement, ledges, perched: i % 2 === 0 }), Math.random)
            expect(['stay', 'jump']).toContain(choice.type)
          }
        }
      }
    })

    it('does nothing when told to stay put, when motion is reduced, or while it is held', () => {
      const tall = [ledgeRising(400)]
      for (const patch of [{ movement: 'still' as const }, { reducedMotion: true }, { held: true }]) {
        expect(chooseLift(ctx({ ledges: tall, ...patch }), roll(0))).toEqual({ type: 'stay' })
      }
      expect(liftsAllowed({ movement: 'still', reducedMotion: false, held: false })).toBe(false)
      expect(liftsAllowed({ movement: 'calm', reducedMotion: false, held: false })).toBe(true)
    })

    it('does not climb windows with climbing off or when calm', () => {
      const tall = [ledgeRising(400)]
      expect(chooseLift(ctx({ ledges: tall, climb: false }), roll(0)).type).not.toBe('jump')
      expect(chooseLift(ctx({ ledges: tall, movement: 'calm' }), roll(0)).type).toBe('stay')
    })

    it('jumps to a tall edge about CLIMB_CHANCE of the time when playful or chaotic, never when calm', () => {
      // Counted over an even sweep of rolls.
      const share = (movement: LiftContext['movement'], ledges: LiftContext['ledges']) => {
        let hits = 0
        const n = 1000
        for (let i = 0; i < n; i += 1) {
          const type = chooseLift(ctx({ movement, ledges }), roll(i / n)).type
          if (type === 'jump') hits += 1
        }
        return hits / n
      }
      const tall = [ledgeRising(400)]
      expect(share('calm', tall)).toBe(0)
      expect(share('playful', tall)).toBeCloseTo(CLIMB_CHANCE, 1)
      expect(share('chaotic', tall)).toBeCloseTo(CLIMB_CHANCE, 1)
    })
  })

  describe('fallTarget', () => {
    it('lands on the ground when nothing is below', () => {
      expect(fallTarget({ x: 300, y: 200 }, [], ground, pet)).toEqual({ x: 300, y: ground, ledge: null })
    })

    it('lands on the nearest window edge below that its middle is over', () => {
      const high = ledgeRising(500, 1, 100, 600)
      const low = ledgeRising(200, 2, 200, 300)
      expect(fallTarget({ x: 300, y: ground - 600 }, [high, low], ground, pet)).toEqual({ x: 300, y: high.y - pet.height, ledge: high })
      expect(fallTarget({ x: 300, y: ground - 400 }, [high, low], ground, pet)).toEqual({ x: 300, y: low.y - pet.height, ledge: low })
    })

    it('skips an edge it is not over, one above it, and keeps one it already stands on', () => {
      const elsewhere = ledgeRising(200, 3, 800, 300)
      expect(fallTarget({ x: 300, y: ground - 400 }, [elsewhere], ground, pet).ledge).toBeNull()
      const above = ledgeRising(500, 1, 100, 600)
      expect(fallTarget({ x: 300, y: ground - 300 }, [above], ground, pet).ledge).toBeNull()
      const under = ledgeRising(200, 2, 200, 300)
      expect(fallTarget({ x: 300, y: under.y - pet.height }, [under], ground, pet).y).toBe(under.y - pet.height)
    })

    it('moves onto an edge it overhangs', () => {
      const edge = ledgeRising(200, 1, 100, 300)
      expect(fallTarget({ x: 80, y: ground - 400 }, [edge], ground, pet)).toMatchObject({ x: 100, ledge: edge })
      expect(fallTarget({ x: 350, y: ground - 400 }, [edge], ground, pet)).toMatchObject({ x: 100 + 300 - 64, ledge: edge })
    })

    it('stays put when already on or below the ground', () => {
      expect(fallTarget({ x: 300, y: ground }, [], ground, pet).y).toBe(ground)
      expect(fallTarget({ x: 300, y: ground + 5 }, [], ground, pet).y).toBe(ground + 5)
    })
  })

  describe('fallMs', () => {
    it('accelerates under gravity, so twice as far takes about 1.4 times as long', () => {
      expect(fallMs(0)).toBe(0)
      expect(fallMs(100)).toBe(Math.round(Math.sqrt((2 * 100) / GRAVITY) * 1000))
      expect(fallMs(200) / fallMs(100)).toBeCloseTo(Math.SQRT2, 1)
    })

    it('stops speeding up at the top speed, so a long fall grows in a straight line', () => {
      expect(fallCapped(100)).toBe(false)
      expect(fallCapped(600)).toBe(true)
      const step = fallMs(1500) - fallMs(1000)
      expect(step).toBeCloseTo((500 / FALL_MAX_SPEED) * 1000, -1)
      expect(fallMs(2000) - fallMs(1500)).toBeCloseTo(step, -1)
    })

    it('takes little more than a second to fall the height of a tall screen', () => {
      expect(fallMs(1200)).toBeLessThan(1400)
    })
  })

  it('says whether a drop in mid-air falls: only with climbing on, moving, and motion allowed', () => {
    const on = { movement: 'calm' as const, climb: true, reducedMotion: false }
    expect(dropFalls(on)).toBe(true)
    expect(dropFalls({ ...on, movement: 'chaotic' })).toBe(true)
    expect(dropFalls({ ...on, climb: false })).toBe(false)
    expect(dropFalls({ ...on, movement: 'still' })).toBe(false)
    expect(dropFalls({ ...on, reducedMotion: true })).toBe(false)
  })

  describe('a jump like a cat\'s', () => {
    const from = { x: 100, y: ground }
    const up = { x: 300, y: ground - 90 }

    it('looks, then crouches, for a moment each', () => {
      expect(JUMP_LOOK_MS).toBeGreaterThan(JUMP_CROUCH_MS)
      expect(JUMP_CROUCH_MS).toBeGreaterThan(0)
    })

    it('takes longer the farther it goes, within a clamp', () => {
      expect(jumpMs(0)).toBe(JUMP_MIN_MS)
      expect(jumpMs(10_000)).toBe(JUMP_MAX_MS)
      expect(jumpMs(300)).toBeGreaterThan(jumpMs(100))
      expect(jumpMs(300)).toBeLessThanOrEqual(JUMP_MAX_MS)
      expect(jumpMs(-300)).toBe(jumpMs(300))
    })

    it('arcs up 0.6 pet heights above the higher stance when jumping up', () => {
      expect(jumpApexY(from, up, pet)).toBeCloseTo(up.y - pet.height * JUMP_CLEAR)
      const path = jumpPath(from, up, pet)
      expect(path).toHaveLength(JUMP_STEPS + 1)
      expect(path[0]).toEqual(from)
      expect(path[path.length - 1]).toEqual(up)
      const top = Math.min(...path.map((p) => p.y))
      // The samples are at fixed steps, so they come near the peak, never above it.
      expect(top).toBeGreaterThanOrEqual(jumpApexY(from, up, pet) - 0.001)
      expect(top).toBeLessThan(up.y - pet.height * 0.5)
    })

    it('moves evenly sideways, and the height rises then falls', () => {
      const path = jumpPath(from, up, pet, 10)
      path.forEach((p, i) => expect(p.x).toBeCloseTo(from.x + (up.x - from.x) * (i / 10)))
      const peak = path.reduce((best, p, i) => (p.y < path[best].y ? i : best), 0)
      expect(peak).toBeGreaterThan(0)
      expect(peak).toBeLessThan(10)
      for (let i = 1; i <= peak; i += 1) expect(path[i].y).toBeLessThanOrEqual(path[i - 1].y)
      for (let i = peak + 1; i <= 10; i += 1) expect(path[i].y).toBeGreaterThanOrEqual(path[i - 1].y)
    })

    it('hops 0.35 pet heights up before coming down, when jumping down', () => {
      const high = { x: 300, y: ground - 90 }
      const low = { x: 300, y: ground }
      expect(jumpApexY(high, low, pet)).toBeCloseTo(high.y - pet.height * JUMP_HOP)
      const path = jumpPath(high, low, pet)
      expect(path[0]).toEqual(high)
      expect(path[path.length - 1]).toEqual(low)
      expect(Math.min(...path.map((p) => p.y))).toBeLessThan(high.y)
      expect(Math.min(...path.map((p) => p.y))).toBeGreaterThanOrEqual(high.y - pet.height * JUMP_HOP - 0.001)
    })

    it('keeps the arc inside the top of the screen', () => {
      const near = { x: 0, y: 10 }
      expect(jumpApexY({ y: 200 }, near, pet)).toBe(0)
      expect(Math.min(...jumpPath({ x: 0, y: 200 }, near, pet).map((p) => p.y))).toBeGreaterThanOrEqual(0)
    })

    it('needs a window that holds the whole arc, apex included, and both ends', () => {
      const reach = jumpReach(from, up, pet)
      expect(reach.y).toBeCloseTo(jumpApexY(from, up, pet))
      expect(reach.y).toBeLessThan(up.y)
      expect(reach.y + reach.height).toBe(from.y + pet.height)
      expect(reach.x).toBe(100)
      expect(reach.x + reach.width).toBe(300 + pet.width)
      const down = jumpReach({ x: 300, y: ground - 90 }, { x: 300, y: ground }, pet)
      expect(down.y).toBeLessThan(ground - 90)
      expect(down.y + down.height).toBe(ground + pet.height)
    })
  })
})
