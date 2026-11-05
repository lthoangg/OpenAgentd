import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  DRAWER_SPRING,
  _resetDrawerMotionsForTests,
  getDrawerMotion,
  releaseVelocity,
  springState,
} from '@/lib/drawer-motion'

const OMEGA = Math.sqrt(DRAWER_SPRING.stiffness)

describe('drawer spring', () => {
  it('is critically damped (damping ratio 1)', () => {
    expect(DRAWER_SPRING.damping).toBeCloseTo(2 * Math.sqrt(DRAWER_SPRING.stiffness), 10)
  })

  it('starts at the release position and velocity', () => {
    const s = springState(0.3, 1, 2, 0)
    expect(s.x).toBeCloseTo(0.3, 10)
    expect(s.v).toBeCloseTo(2, 10)
  })

  it('carries the release velocity: a faster fling is further along after the same time', () => {
    const slow = springState(0.3, 1, 0, 0.05).x
    const fast = springState(0.3, 1, 8, 0.05).x
    expect(fast).toBeGreaterThan(slow)
  })

  it('never passes its target at any velocity the release allows', () => {
    for (const raw of [0, 0.5, 3, 10, 50, 1e6]) {
      for (const [from, to] of [[0.2, 1], [0.7, 0], [0.01, 1], [0.99, 0]] as const) {
        const v = releaseVelocity(raw * Math.sign(to - from), from, to)
        for (let t = 0; t <= 2; t += 0.004) {
          const x = springState(from, to, v, t).x
          // Hard edges: never past fully open or fully shut, within float error.
          expect(to === 1 ? x : -x).toBeLessThanOrEqual((to === 1 ? 1 : 0) + 1e-9)
        }
      }
    }
  })

  it('overshoots without the cap (why the cap exists)', () => {
    const x = Array.from({ length: 200 }, (_, i) => springState(0.2, 1, 40, i * 0.005).x)
    expect(Math.max(...x)).toBeGreaterThan(1)
  })

  it('uses no velocity when the finger heads away from the goal', () => {
    expect(releaseVelocity(-3, 0.4, 1)).toBe(0)
    expect(releaseVelocity(3, 0.4, 0)).toBe(0)
    expect(releaseVelocity(0, 0.4, 1)).toBe(0)
    expect(releaseVelocity(Number.NaN, 0.4, 1)).toBe(0)
  })

  it('caps a hard fling at the fastest start that still stops on its target', () => {
    expect(releaseVelocity(1e6, 0.5, 1)).toBeCloseTo(OMEGA * 0.5, 10)
    expect(releaseVelocity(-1e6, 0.5, 0)).toBeCloseTo(-OMEGA * 0.5, 10)
    expect(releaseVelocity(2, 0.5, 1)).toBe(2)
  })
})

describe('DrawerMotion', () => {
  let frames: Array<(now: number) => void>
  const realRaf = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame

  /** Run one frame at ``ms`` after the start. */
  const frame = (ms: number) => {
    const queued = frames
    frames = []
    for (const callback of queued) callback(ms)
  }

  beforeEach(() => {
    frames = []
    globalThis.requestAnimationFrame = ((callback: (now: number) => void) => frames.push(callback)) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => { frames = [] }) as typeof cancelAnimationFrame
    document.body.innerHTML = '<aside data-edge-drawer="d"></aside><div data-edge-drawer-scrim="d"></div>'
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    globalThis.cancelAnimationFrame = realCancel
    _resetDrawerMotionsForTests()
  })

  const drawer = () => document.querySelector<HTMLElement>('[data-edge-drawer="d"]')!
  const scrim = () => document.querySelector<HTMLElement>('[data-edge-drawer-scrim="d"]')!

  it('writes the finger position to the drawer translate and scrim opacity', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: -280, reduced: false })
    motion.drag(0.25)
    expect(drawer().style.translate).toBe('-210px 0')
    expect(scrim().style.opacity).toBe('0.25')
    motion.drag(1)
    expect(drawer().style.translate).toBe('')
    expect(scrim().style.opacity).toBe('1')
  })

  it('clamps the finger to fully shut and fully open (hard edges)', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: -280, reduced: false })
    motion.drag(1.4)
    expect(motion.progress).toBe(1)
    motion.drag(-0.4)
    expect(motion.progress).toBe(0)
    expect(drawer().style.translate).toBe('-280px 0')
  })

  it('springs to the target on release, keeping the finger speed, and lands exactly', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: -280, reduced: false })
    motion.drag(0.4)
    motion.settle(1, 3)
    frame(1000) // first frame fixes t = 0
    expect(motion.progress).toBeCloseTo(0.4, 6)
    frame(1016)
    const afterOneFrame = motion.progress
    // 3/s of release speed plus the spring's own pull: well past 0.4 + 3 * 0.016.
    expect(afterOneFrame).toBeGreaterThan(0.4 + 3 * 0.016)
    let at = 1016
    let last = afterOneFrame
    while (frames.length && at < 4000) {
      at += 16
      frame(at)
      expect(motion.progress).toBeLessThanOrEqual(1)
      expect(motion.progress).toBeGreaterThanOrEqual(last - 1e-9)
      last = motion.progress
    }
    expect(motion.progress).toBe(1)
    expect(drawer().style.translate).toBe('')
  })

  it('a fling away from the goal starts from rest', () => {
    const toward = getDrawerMotion('d')
    toward.configure({ hidden: -280, reduced: false })
    toward.drag(0.4)
    toward.settle(0, 5) // finger moving toward open, goal shut
    frame(0)
    frame(16)
    // Exactly the spring from rest, not one seeded with the fling's 5/s.
    expect(toward.progress).toBeCloseTo(springState(0.4, 0, 0, 0.016).x, 9)
  })

  it('snaps under reduced motion', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: -280, reduced: true })
    motion.drag(0.4)
    motion.settle(0, 2)
    expect(motion.progress).toBe(0)
    expect(frames).toHaveLength(0)
    expect(drawer().style.translate).toBe('-280px 0')
  })

  it('ignores a repeat settle to the target it is already heading for', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: -280, reduced: false })
    motion.drag(0.4)
    motion.settle(1, 3)
    frame(0)
    frame(32)
    const mid = motion.progress
    motion.settle(1, 0) // the state change the release caused
    frame(48)
    expect(motion.progress).toBeGreaterThan(mid)
  })

  it('a new touch takes the drawer over mid-spring', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: -280, reduced: false })
    motion.drag(0.4)
    motion.settle(1, 0)
    frame(0)
    frame(16)
    motion.drag(0.5)
    expect(motion.progress).toBe(0.5)
    expect(frames).toHaveLength(0)
  })

  it('mounts where the finger left it when a spring is already running to it', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: 272, reduced: false })
    motion.drag(0.3)
    motion.settle(1, 2)
    frame(0)
    frame(16)
    const mid = motion.progress
    motion.attach(1)
    expect(motion.progress).toBe(mid)
    expect(drawer().style.translate).not.toBe('')
  })

  it('detach leaves the drawer unstyled', () => {
    const motion = getDrawerMotion('d')
    motion.configure({ hidden: -280, reduced: false })
    motion.drag(0.2)
    motion.detach()
    expect(drawer().style.translate).toBe('')
    expect(scrim().style.opacity).toBe('')
  })
})
