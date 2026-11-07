/**
 * Drawer motion — the imperative driver behind the phone's edge-swipe
 * drawers (the session sidebar and the Review panel).
 *
 * A drawer is one number, ``progress`` (0 = shut, 1 = open). The finger
 * writes it on every touchmove straight to the DOM (``translate`` on the
 * drawer, ``opacity`` on its scrim), so the chat above never re-renders per
 * frame. On release a **critically damped spring** (stiffness 400, damping
 * 40, ratio 1) carries it to its resting place, seeded with the finger's
 * release velocity so the drawer keeps moving as fast as the hand was.
 *
 * Hard edges: no rubber band. ``progress`` is clamped to 0…1 on every write,
 * and the release velocity is capped at the most a critically damped spring
 * can take without crossing its target, so a hard fling decelerates into the
 * edge instead of striking it. A fling toward the opposite edge from the goal
 * starts from rest.
 *
 * Surfaces are found by attribute, not by ref, because the animation library
 * owns the aside's ref and ``transform``: ``data-edge-drawer="<id>"`` marks
 * the drawer and ``data-edge-drawer-scrim="<id>"`` its scrim. A drawer that
 * is not mounted (the Review panel before it opens) still tracks ``progress``,
 * so it mounts where the finger left it.
 */

/** Critically damped: damping = 2 * sqrt(stiffness * mass), mass 1. */
export const DRAWER_SPRING = { stiffness: 400, damping: 40 } as const

const OMEGA = Math.sqrt(DRAWER_SPRING.stiffness)
/** Default rest thresholds, in progress units (0.001 ≈ 0.3px of a 272px drawer). */
const REST_DISTANCE = 0.001
const REST_SPEED = 0.02
/** ms: the most spring time one animation frame may advance (one 30fps frame). */
const MAX_FRAME_MS = 34

/** Position and velocity of the critically damped spring ``t`` seconds after release. */
export function springState(from: number, to: number, velocity: number, t: number): { x: number; v: number } {
  const d0 = from - to
  const c2 = velocity + OMEGA * d0
  const decay = Math.exp(-OMEGA * t)
  return {
    x: to + (d0 + c2 * t) * decay,
    v: (c2 - OMEGA * (d0 + c2 * t)) * decay,
  }
}

/**
 * The release velocity (progress/s) the spring starts with. Zero when the
 * finger was heading away from ``to``; otherwise capped at ``OMEGA * |to -
 * from|``, the fastest start from which a critically damped spring still
 * approaches ``to`` without crossing it.
 */
export function releaseVelocity(velocity: number, from: number, to: number): number {
  const distance = to - from
  if (distance === 0 || !Number.isFinite(velocity) || velocity * distance <= 0) return 0
  return Math.sign(velocity) * Math.min(Math.abs(velocity), OMEGA * Math.abs(distance))
}

/**
 * A number that follows the finger exactly (``set``) and springs to a target
 * on release (``settle``), writing every change through ``write``. No React
 * state: ``write`` touches the DOM.
 */
export class SpringValue {
  value: number
  /** Reduced motion: ``settle`` snaps. */
  reduced = false
  private target: number | null = null
  private frame = 0
  private readonly write: (value: number) => void
  private readonly min: number
  private readonly max: number
  private readonly restDistance: number
  private readonly restSpeed: number

  constructor(
    write: (value: number) => void,
    { initial = 0, min = -Infinity, max = Infinity, restDistance = REST_DISTANCE, restSpeed = REST_SPEED } = {},
  ) {
    this.write = write
    this.value = initial
    this.min = min
    this.max = max
    this.restDistance = restDistance
    this.restSpeed = restSpeed
  }

  private clamp(value: number): number {
    return Math.min(this.max, Math.max(this.min, value))
  }

  /** True while a settle toward ``target`` is running. */
  isSettlingTo(target: number): boolean {
    return this.target !== null && this.target === target
  }

  /** The finger moves the value: follow it exactly, dropping any settle in flight. */
  set(value: number): void {
    this.cancel()
    this.value = this.clamp(value)
    this.write(this.value)
  }

  /**
   * Spring to ``target`` carrying ``velocity`` (units/s). A no-op while a
   * settle to the same target is already running, so a gesture's release and
   * the state change it causes agree instead of restarting each other.
   */
  settle(target: number, velocity = 0): void {
    if (this.isSettlingTo(target)) return
    this.cancel()
    if (this.reduced || this.value === target) {
      this.value = target
      this.write(target)
      return
    }
    const from = this.value
    const v0 = releaseVelocity(velocity, from, target)
    this.target = target
    // Spring time advances by at most one 30fps frame per tick: when a push
    // mounts a heavy page, the long frame it costs slows the slide for a
    // moment instead of skipping a chunk of it (the "jump" on a phone).
    let last: number | undefined
    let elapsed = 0
    const tick = (now: number | undefined) => {
      const time = now ?? performance.now()
      elapsed += last === undefined ? 0 : Math.min(time - last, MAX_FRAME_MS)
      last = time
      const { x, v } = springState(from, target, v0, elapsed / 1000)
      if (Math.abs(x - target) < this.restDistance && Math.abs(v) < this.restSpeed) {
        this.value = target
        this.target = null
        this.frame = 0
        this.write(target)
        return
      }
      this.value = this.clamp(x)
      this.write(this.value)
      this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  cancel(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.target = null
  }
}

export class DrawerMotion {
  /** Signed px the drawer is translated by when shut (``-280`` for the left sidebar). */
  hidden = 0
  readonly id: string
  private readonly spring: SpringValue
  private drawerEl: HTMLElement | null = null
  private scrimEl: HTMLElement | null = null

  constructor(id: string) {
    this.id = id
    this.spring = new SpringValue(() => this.apply(), { min: 0, max: 1 })
  }

  /** 0 = shut, 1 = open. */
  get progress(): number {
    return this.spring.value
  }

  /** Reduced motion: a release or toggle snaps. */
  get reduced(): boolean {
    return this.spring.reduced
  }

  configure({ hidden, reduced }: { hidden: number; reduced: boolean }): void {
    this.hidden = hidden
    this.spring.reduced = reduced
  }

  /** The finger moves the drawer: follow it exactly, dropping any settle in flight. */
  drag(progress: number): void {
    this.spring.set(progress)
  }

  /** Spring to ``target`` (1 open, 0 shut) carrying ``velocity`` (progress/s). */
  settle(target: number, velocity = 0): void {
    this.spring.settle(target, velocity)
  }

  /**
   * A drawer (re)mounts at ``target``: jump there, unless a settle toward it
   * is already running (the Review panel mounts mid-release).
   */
  attach(target: number): void {
    if (this.spring.isSettlingTo(target)) {
      this.apply()
      return
    }
    this.spring.set(target)
  }

  /** The drawer is no longer driven (a phone turned desktop): leave its styles alone. */
  detach(): void {
    this.spring.cancel()
    this.drawerEl?.style.removeProperty('translate')
    this.scrimEl?.style.removeProperty('opacity')
    this.drawerEl = null
    this.scrimEl = null
  }

  cancel(): void {
    this.spring.cancel()
  }

  /** Write ``progress`` to the drawer and its scrim. */
  apply(): void {
    if (!this.drawerEl?.isConnected) this.drawerEl = document.querySelector<HTMLElement>(`[data-edge-drawer="${this.id}"]`)
    if (!this.scrimEl?.isConnected) this.scrimEl = document.querySelector<HTMLElement>(`[data-edge-drawer-scrim="${this.id}"]`)
    const progress = this.progress
    if (this.drawerEl) {
      this.drawerEl.style.translate = progress >= 1 ? '' : `${this.hidden * (1 - progress)}px 0`
    }
    if (this.scrimEl) this.scrimEl.style.opacity = String(progress)
  }
}

const motions = new Map<string, DrawerMotion>()

/** The driver for the drawer ``id``, created on first use. */
export function getDrawerMotion(id: string): DrawerMotion {
  let motion = motions.get(id)
  if (!motion) {
    motion = new DrawerMotion(id)
    motions.set(id, motion)
  }
  return motion
}

/** Tests: forget every drawer so one test's progress never leaks into the next. */
export function _resetDrawerMotionsForTests(): void {
  for (const motion of motions.values()) motion.cancel()
  motions.clear()
}
