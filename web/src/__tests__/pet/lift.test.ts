/**
 * The pet changes height with a ladder, a balloon or a fall: what it picks,
 * when it may, where it goes and lands, and how long each takes.
 */
import { describe, expect, it } from 'bun:test'
import {
  BALLOON_CHANCE,
  BALLOON_DRIFT,
  BALLOON_HOVER_MS,
  BALLOON_MAX_RISE,
  CLIMB_CHANCE,
  FALL_MAX_SPEED,
  GRAVITY,
  JUMP_DOWN_CHANCE,
  LADDER_CHANCE,
  LADDER_OVER,
  TOP_ROOM,
  balloonMinY,
  balloonPlan,
  balloonRoom,
  chooseLift,
  climbMs,
  dropFalls,
  fallCapped,
  fallMs,
  fallTarget,
  floatMs,
  ladderBox,
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
    expect(petPose({ ...base, lift: 'climb' })).toBe('climb')
    expect(petPose({ ...base, lift: 'float', reaction: 'hop', held: true })).toBe('float')
    expect(petPose({ ...base, lift: 'fall' })).toBe('fall')
    expect(petPose({ ...base, lift: 'sit', sitting: false })).toBe('sit')
  })

  it('still raises the alert for a waiting question, and never moves when told not to', () => {
    expect(petPose({ ...base, lift: 'climb', status: { running: 0, needsInput: 1 } })).toBe('alert')
    expect(petPose({ ...base, lift: 'climb', movement: 'still' })).toBe('sit')
    expect(petPose({ ...base, lift: 'float', reducedMotion: true })).toBe('sit')
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
    toys: true,
    reducedMotion: false,
    busy: false,
    held: false,
    perched: false,
    x: 300,
    y: ground,
    groundY: ground,
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
    it('jumps to a window edge no taller than twice the pet, and takes a ladder to a taller one', () => {
      expect(chooseLift(ctx({ ledges: [ledgeRising(90)] }), roll(0))).toEqual({ type: 'jump', ledge: ledgeRising(90) })
      expect(chooseLift(ctx({ ledges: [ledgeRising(96)] }), roll(0))).toEqual({ type: 'jump', ledge: ledgeRising(96) })
      expect(chooseLift(ctx({ ledges: [ledgeRising(97)] }), roll(0))).toEqual({ type: 'ladder', ledge: ledgeRising(97) })
      expect(chooseLift(ctx({ ledges: [ledgeRising(400)] }), roll(0))).toEqual({ type: 'ladder', ledge: ledgeRising(400) })
    })

    it('takes the window edge nearest to it, and ignores one below it', () => {
      const far = ledgeRising(300, 2, 900, 400)
      const near = ledgeRising(250, 1, 200, 400)
      expect(chooseLift(ctx({ ledges: [far, near] }), roll(0))).toEqual({ type: 'ladder', ledge: near })
      expect(chooseLift(ctx({ ledges: [ledgeRising(-100)] }), roll(0.99))).toEqual({ type: 'stay' })
    })

    it('jumps even to a tall edge with ladders and balloons off, or while an agent runs', () => {
      const tall = ledgeRising(400)
      expect(chooseLift(ctx({ ledges: [tall], toys: false }), roll(0))).toEqual({ type: 'jump', ledge: tall })
      expect(chooseLift(ctx({ ledges: [tall], busy: true }), roll(0))).toEqual({ type: 'jump', ledge: tall })
    })

    it('climbs down by ladder from a tall window and by a jump from a low one', () => {
      const down = (rise: number, patch: Partial<LiftContext> = {}) =>
        chooseLift(ctx({ perched: true, y: ground - rise, ledges: [ledgeRising(rise)], ...patch }), roll(0))
      expect(down(400)).toEqual({ type: 'ladder', ledge: null })
      expect(down(96)).toEqual({ type: 'jump', ledge: null })
      expect(down(400, { toys: false })).toEqual({ type: 'jump', ledge: null })
    })

    it('uses its own chance for each way of moving, so a roll between them does nothing', () => {
      const tall = [ledgeRising(400)]
      expect(chooseLift(ctx({ ledges: tall }), roll(LADDER_CHANCE.playful - 0.001)).type).toBe('ladder')
      // Past the ladder band, inside the balloon band.
      expect(chooseLift(ctx({ ledges: tall }), roll(LADDER_CHANCE.playful + 0.001, 0.5, 0.5, 0.5, 0.5)).type).toBe('balloon')
      // Past both.
      expect(chooseLift(ctx({ ledges: tall }), roll(LADDER_CHANCE.playful + BALLOON_CHANCE.playful + 0.001)).type).toBe('stay')
      const low = [ledgeRising(60)]
      expect(chooseLift(ctx({ ledges: low }), roll(CLIMB_CHANCE - 0.001)).type).toBe('jump')
      expect(chooseLift(ctx({ ledges: low }), roll(CLIMB_CHANCE + 0.001, 0.5, 0.5, 0.5, 0.5)).type).toBe('balloon')
      const standing = (rise: number) => ctx({ perched: true, y: ground - rise, ledges: [ledgeRising(rise)] })
      expect(chooseLift(standing(60), roll(JUMP_DOWN_CHANCE - 0.001)).type).toBe('jump')
      expect(chooseLift(standing(400), roll(LADDER_CHANCE.playful + 0.001)).type).not.toBe('ladder')
    })

    it('floats up on a balloon from open ground, even with no window about', () => {
      const choice = chooseLift(ctx({ ledges: [] }), roll(0, 0.5, 0.5, 0.5))
      expect(choice.type).toBe('balloon')
      if (choice.type === 'balloon') {
        expect(choice.plan.ledge).toBeNull()
        expect(choice.plan.toY).toBeLessThan(ground)
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

    it('never climbs a ladder or floats while an agent runs, nor with the setting off', () => {
      const tall = [ledgeRising(400)]
      for (const patch of [{ busy: true }, { toys: false }]) {
        for (const value of [0, LADDER_CHANCE.playful + 0.001, 0.2]) {
          const choice = chooseLift(ctx({ ledges: tall, ...patch }), roll(value, 0.5, 0.5, 0.5, 0.5))
          expect(['ladder', 'balloon']).not.toContain(choice.type)
        }
      }
    })

    it('does not climb windows with climbing off or when calm, but a calm pet may still float', () => {
      const tall = [ledgeRising(400)]
      expect(chooseLift(ctx({ ledges: tall, climb: false }), roll(0)).type).not.toBe('ladder')
      expect(chooseLift(ctx({ ledges: tall, climb: false }), roll(0)).type).not.toBe('jump')
      expect(chooseLift(ctx({ ledges: tall, movement: 'calm' }), roll(0.01, 0.5, 0.5, 0.5, 0.5)).type).toBe('balloon')
      expect(chooseLift(ctx({ ledges: tall, movement: 'calm' }), roll(BALLOON_CHANCE.calm + 0.001)).type).toBe('stay')
      // Climbing off: a float that comes back down to the ground is still fine.
      const choice = chooseLift(ctx({ ledges: tall, climb: false }), roll(0, 0, 0.5, 0.5, 0.5))
      expect(choice.type).toBe('balloon')
      if (choice.type === 'balloon') expect(choice.plan.ledge).toBeNull()
    })

    it('does it more often the more playful it is, and rarely when calm', () => {
      expect(BALLOON_CHANCE.still).toBe(0)
      expect(LADDER_CHANCE.still).toBe(0)
      expect(BALLOON_CHANCE.calm).toBeGreaterThan(0)
      expect(BALLOON_CHANCE.calm).toBeLessThan(BALLOON_CHANCE.playful)
      expect(BALLOON_CHANCE.playful).toBeLessThan(BALLOON_CHANCE.chaotic)
      expect(LADDER_CHANCE.calm).toBe(0)
      expect(LADDER_CHANCE.playful).toBeLessThan(LADDER_CHANCE.chaotic)
      // Occasional: well under half the sits, even chaotic.
      expect(BALLOON_CHANCE.chaotic + LADDER_CHANCE.chaotic).toBeLessThan(0.5)

      // Counted over an even sweep of rolls.
      const share = (movement: LiftContext['movement'], ledges: LiftContext['ledges']) => {
        let hits = 0
        const n = 1000
        for (let i = 0; i < n; i += 1) {
          const type = chooseLift(ctx({ movement, ledges }), roll(i / n, 0.5, 0.5, 0.5, 0.5)).type
          if (type === 'ladder' || type === 'balloon') hits += 1
        }
        return hits / n
      }
      const tall = [ledgeRising(400)]
      expect(share('calm', tall)).toBeCloseTo(BALLOON_CHANCE.calm, 1)
      expect(share('playful', tall)).toBeCloseTo(LADDER_CHANCE.playful + BALLOON_CHANCE.playful, 1)
      expect(share('chaotic', tall)).toBeCloseTo(LADDER_CHANCE.chaotic + BALLOON_CHANCE.chaotic, 1)
      expect(share('calm', tall)).toBeLessThan(share('playful', tall))
      expect(share('playful', tall)).toBeLessThan(share('chaotic', tall))
    })
  })

  describe('balloonPlan', () => {
    const plan = (patch: Partial<LiftContext> = {}, ...values: number[]) => balloonPlan(ctx(patch), roll(...values))

    it('rises at least one and a half pet heights, and drifts a little sideways', () => {
      const low = plan({}, 0.5, 1)
      expect(low?.toY).toBeCloseTo(ground - pet.height * 1.5)
      expect(low?.toX).toBeCloseTo(300)
      expect(plan({}, 0, 0)?.toX).toBeCloseTo(300 - BALLOON_DRIFT)
      expect(plan({}, 1, 0)?.toX).toBeCloseTo(300 + BALLOON_DRIFT)
    })

    it('floats no higher than the longest rise, nor into the room a balloon needs at the top', () => {
      expect(plan({}, 0.5, 0)?.toY).toBeCloseTo(ground - BALLOON_MAX_RISE)
      // On a short screen the top room is the limit.
      const short = plan({ y: 200, groundY: 200, area: { width: 1440, height: 300 } }, 0.5, 0)
      expect(short?.toY).toBeGreaterThanOrEqual(balloonMinY(300, pet))
      expect(balloonMinY(900, pet)).toBe(balloonRoom(pet.width))
      expect(balloonRoom(64)).toBeGreaterThan(TOP_ROOM)
    })

    it('stays inside the screen sideways', () => {
      expect(plan({ x: 10 }, 0, 0.5)?.toX).toBe(0)
      expect(plan({ x: 1440 - 64 - 5 }, 1, 0.5)?.toX).toBe(1440 - 64)
    })

    it('has no plan where there is no room to rise', () => {
      expect(plan({ y: 60, groundY: 60 }, 0.5, 0.5)).toBeNull()
      expect(plan({ y: balloonMinY(900, pet) + 20, groundY: ground }, 0.5, 0.5)).toBeNull()
    })

    it('hovers between three and six seconds', () => {
      expect(plan({}, 0.5, 0.5, 0)?.hoverMs).toBe(BALLOON_HOVER_MS[0])
      expect(plan({}, 0.5, 0.5, 1)?.hoverMs).toBeCloseTo(BALLOON_HOVER_MS[1])
    })

    it('sometimes steers to a window edge it can reach, and steps onto it', () => {
      const edge = ledgeRising(200, 4, 250, 300)
      const steered = plan({ ledges: [edge] }, 0.5, 0)
      expect(steered?.ledge).toEqual(edge)
      expect(steered?.toY).toBe(edge.y - pet.height)
      expect(steered?.toX).toBeGreaterThanOrEqual(edge.x)
      expect(steered?.toX).toBeLessThanOrEqual(edge.x + edge.width - pet.width)
      // Not this time: it hovers at a free height instead.
      expect(plan({ ledges: [edge] }, 0.5, 0.99, 0.5)?.ledge).toBeNull()
    })

    it('does not steer to an edge too far to drift to, one under it, or with climbing off', () => {
      expect(plan({ ledges: [ledgeRising(200, 4, 900, 300)] }, 0.5, 0)?.ledge).toBeNull()
      expect(plan({ ledges: [ledgeRising(20, 4, 250, 300)] }, 0.5, 0)?.ledge).toBeNull()
      expect(plan({ ledges: [ledgeRising(200, 4, 250, 300)], climb: false }, 0.5, 0)?.ledge).toBeNull()
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

  it('draws the ladder from the lower stance up to rails just over the upper edge', () => {
    const box = ladderBox(300, ground, ground - 400, pet)
    expect(box.width).toBe(22)
    expect(box.left).toBe(300 + (64 - 22) / 2)
    expect(box.top).toBe(ground - 400 + pet.height - LADDER_OVER)
    expect(box.top + box.height).toBe(ground + pet.height)
    // The same ladder whichever way it is climbed.
    expect(ladderBox(300, ground - 400, ground, pet)).toEqual(box)
  })

  it('takes longer to climb further, and never less than a moment', () => {
    expect(climbMs(10)).toBe(600)
    expect(climbMs(-360)).toBe(4000)
    expect(floatMs(10)).toBe(1200)
    expect(floatMs(10_000)).toBe(6000)
    expect(floatMs(240)).toBe(3000)
  })
})
