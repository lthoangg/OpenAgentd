/**
 * The desktop pet's data, as the desktop shell sends it
 * (desktop/src-tauri/src/pet.rs), and the pure decisions about what it does:
 * its pose, and which bubble shows.
 */
import { sessionKey } from '@/lib/session-key'

export type PetCharacter = 'cat' | 'duck' | 'crab'
export type PetColour = 'orange' | 'paper' | 'bark' | 'blue'
export type PetSize = 'small' | 'medium' | 'large'
export type PetMovement = 'still' | 'calm' | 'playful' | 'chaotic'

/** What sets the characters apart besides their drawing. */
export interface CharacterTraits {
  label: string
  /** Its reply to a poke. */
  voice: string
  /** Walking speed against the cat's. */
  pace: number
  /** Walks sideways, so it never turns around. */
  sideways: boolean
}

export const CHARACTER_TRAITS: Record<PetCharacter, CharacterTraits> = {
  cat: { label: 'Cat', voice: 'Meow!', pace: 1, sideways: false },
  duck: { label: 'Duck', voice: 'Quack!', pace: 0.7, sideways: false },
  crab: { label: 'Crab', voice: 'Snip snip!', pace: 0.85, sideways: true },
}

export interface BubbleKinds {
  inputNeeded: boolean
  assistantDone: boolean
  reminderFired: boolean
}

/** Settings → General → Desktop pet (stored by the shell). */
export interface PetSettings {
  enabled: boolean
  character: PetCharacter
  colour: PetColour
  size: PetSize
  movement: PetMovement
  /** Notifications in the bubble instead of the system banner. */
  bubbles: boolean
  bubbleKinds: BubbleKinds
  showWhenFrontmost: boolean
  /** Jump onto other apps' windows (when playful or chaotic). */
  climb: boolean
  /** Ladders and balloons: it now and then changes height with one (not while stay-put). */
  toys: boolean
  /**
   * Where it was dropped: a display, 0..1 across it, and 0..1 down it for
   * the height its feet stand at (missing in older settings: the bottom).
   */
  position: { display: string; x: number; y?: number } | null
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  character: 'cat',
  colour: 'orange',
  size: 'medium',
  movement: 'calm',
  bubbles: true,
  bubbleKinds: { inputNeeded: true, assistantDone: true, reminderFired: true },
  showWhenFrontmost: false,
  climb: true,
  toys: true,
  position: null,
}

export interface PetStatus {
  running: number
  needsInput: number
}

export interface PetView {
  settings: PetSettings
  status: PetStatus
  shown: boolean
  /** The work area and the window's box in it, once the shell has placed the window. */
  area?: PetArea | null
  frame?: Box | null
}

export type BubbleTone = 'input' | 'done' | 'failed' | 'remind'

export interface PetBubble {
  /** The notification id. */
  id: string
  kind: string
  tone: BubbleTone
  sessionId: string | null
  title: string
  body: string
  /** A question's id, once the shell has read it from the server. */
  questionId?: string | null
}

// ── Size and motion ────────────────────────────────────────────────────────

/** The sprite at medium size, in CSS pixels. */
export const PET_WIDTH = 64
export const PET_HEIGHT = 48
export const BUBBLE_WIDTH = 290
/** Room kept above the pet for its marks (the alert, the badge, the z z). */
export const TOP_ROOM = 28
/** Room a bubble needs above the pet; with less it opens below. */
export const BUBBLE_ROOM = 200
/** A finished turn or a reminder fades after this long. */
export const BUBBLE_FADE_MS = 8000
/** Unread bubbles kept behind the badge. */
export const MAX_UNREAD = 6
/** Nothing happening for this long and the pet curls up to sleep. */
export const SLEEP_AFTER_MS = 5 * 60 * 1000

export const SIZE_SCALE: Record<PetSize, number> = { small: 0.75, medium: 1, large: 1.4 }

/** Walking speed in CSS px per second; 0 stays put. */
export const WALK_SPEED: Record<PetMovement, number> = { still: 0, calm: 28, playful: 72, chaotic: 90 }

/** How long it sits between walks, in ms: [min, max]. */
export const SIT_PAUSE: Record<PetMovement, [number, number]> = {
  still: [Infinity, Infinity],
  calm: [4000, 10000],
  playful: [1000, 3500],
  chaotic: [600, 2000],
}

/** While an agent runs it sits at its laptop at least this long between walks. */
const BUSY_SIT_MIN = 6000

/**
 * How long it sits between walks, in ms: [min, max]. While an agent runs it
 * mostly works, so the pause is twice as long and never short.
 */
export function sitPause(movement: PetMovement, busy: boolean): [number, number] {
  const [min, max] = SIT_PAUSE[movement]
  if (!busy) return [min, max]
  const busyMin = Math.max(min * 2, BUSY_SIT_MIN)
  return [busyMin, Math.max(max * 2, busyMin + 4000)]
}

/** Folding the laptop before a walk, or opening it after one (matches --pet-fold). */
export const FOLD_MS = 2000

// ── Zoomies ────────────────────────────────────────────────────────────────

/** Running about: dashing back and forth, then standing a while panting. */
export type ZoomPhase = 'run' | 'pant'

/** Running speed, in CSS px per second. */
export const ZOOM_SPEED = 320
/** Dashes in one bout. */
export const ZOOM_DASHES = 4
/** How long it pants after a bout. */
export const PANT_MS = 2500
/** How long between bouts on its own, when chaotic: [min, max] in ms. */
const ZOOM_EVERY: [number, number] = [60_000, 120_000]

/**
 * Ms until the next bout on its own, or null when it never runs about
 * unasked (not chaotic, or an agent is running: zoomies are for idle time).
 */
export function zoomDelay(movement: PetMovement, random: number, busy = false): number | null {
  if (movement !== 'chaotic' || busy) return null
  const [min, max] = ZOOM_EVERY
  return min + random * (max - min)
}

/** Whether a finished turn sets it running about. */
export function zoomsWhenDone(movement: PetMovement): boolean {
  return movement === 'playful' || movement === 'chaotic'
}

// ── The pointer ────────────────────────────────────────────────────────────

/** How long the pointer rests beside the pet before it pounces. */
export const POUNCE_AFTER_MS = 1200

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The pointer rests close beside the pet (not on it): close enough to pounce. */
export function withinPounce(pet: Box, pointer: { x: number; y: number }): boolean {
  const gap = pointer.x < pet.x ? pet.x - pointer.x : pointer.x - (pet.x + pet.width)
  return gap >= 12 && gap <= 160 && pointer.y >= pet.y - 60 && pointer.y <= pet.y + pet.height + 30
}

// ── Climbing on windows ────────────────────────────────────────────────────

/** Another app's window, front first, in the page's CSS px (from the shell). */
export interface OtherWindow {
  id: number
  x: number
  y: number
  width: number
  height: number
}

/** A top edge the pet can stand and walk on; `y` is where its feet go. */
export interface Ledge {
  id: number
  x: number
  y: number
  width: number
}

/** Where the pet stands: which window, and that window's left edge then. */
export interface Perch {
  id: number
  ledgeX: number
}

/** Room kept between the pet and anything above it. */
const HEADROOM = 8
/** How long a jump up or down takes. */
export const JUMP_MS = 420
/** After a sit, the chance it jumps onto a window (when it may climb). */
export const CLIMB_CHANCE = 0.35
/** After a sit on a window, the chance it jumps back down. */
export const JUMP_DOWN_CHANCE = 0.25

/**
 * The top edges the pet can stand on: each window's edge with room above
 * it (not under the top of the screen, not down on the ground), minus what
 * windows in front cover, keeping the widest piece long enough to walk on.
 */
export function ledges(windows: OtherWindow[], area: { width: number; height: number }, pet: { width: number; height: number }): Ledge[] {
  const found: Ledge[] = []
  windows.forEach((w, i) => {
    if (w.y < pet.height + HEADROOM || w.y > area.height - pet.height - HEADROOM) return
    let pieces: Array<[number, number]> = [[Math.max(0, w.x), Math.min(area.width, w.x + w.width)]]
    for (const front of windows.slice(0, i)) {
      // In front and over the space the pet would stand in.
      if (front.y >= w.y + 2 || front.y + front.height <= w.y - pet.height - HEADROOM) continue
      const [lo, hi] = [front.x, front.x + front.width]
      pieces = pieces.flatMap(([a, b]): Array<[number, number]> => {
        if (hi <= a || lo >= b) return [[a, b]]
        return [[a, Math.min(b, lo)], [Math.max(a, hi), b]].filter(([p, q]) => q > p) as Array<[number, number]>
      })
    }
    const widest = pieces.reduce<[number, number] | null>((best, p) => (!best || p[1] - p[0] > best[1] - best[0] ? p : best), null)
    if (widest && widest[1] - widest[0] >= pet.width * 1.5) found.push({ id: w.id, x: widest[0], y: w.y, width: widest[1] - widest[0] })
  })
  return found
}

/**
 * Where a perched pet at `x` goes when the windows change: along with its
 * window, kept on the edge; null when the edge is gone and it falls.
 */
export function followLedge(perch: Perch, x: number, all: Ledge[], pet: { width: number; height: number }): { x: number; y: number; perch: Perch } | null {
  const ledge = all.find((l) => l.id === perch.id)
  if (!ledge) return null
  const moved = x + (ledge.x - perch.ledgeX)
  return {
    x: Math.min(Math.max(moved, ledge.x), ledge.x + ledge.width - pet.width),
    y: ledge.y - pet.height,
    perch: { id: ledge.id, ledgeX: ledge.x },
  }
}

/** Where one dash of the zoomies ends: near the far side of the screen. */
export function dashTarget(x: number, width: number, petWidth: number, random: number): number {
  const room = Math.max(0, width - petWidth)
  const reach = room * (0.05 + random * 0.2)
  return x + petWidth / 2 < width / 2 ? room - reach : reach
}

// ── Ladders, balloons and falls ────────────────────────────────────────────

/** A rise taller than this many pet heights takes a ladder (when it may), not a jump. */
export const LADDER_RISE = 2
/**
 * After a sit, the chance it climbs a ladder (up to a window, or down from
 * one) rather than the jump's CLIMB_CHANCE / JUMP_DOWN_CHANCE. Calm pets do
 * not climb windows at all.
 */
export const LADDER_CHANCE: Record<PetMovement, number> = { still: 0, calm: 0, playful: 0.12, chaotic: 0.25 }
/** After a sit, the chance it floats up on a balloon, which comes after the climbing chances. */
export const BALLOON_CHANCE: Record<PetMovement, number> = { still: 0, calm: 0.04, playful: 0.1, chaotic: 0.2 }
/** When a window edge is in reach of the float, the chance it steers to it. */
export const BALLOON_LEDGE_CHANCE = 0.5
/** Climbing a ladder, in CSS px per second. */
export const CLIMB_SPEED = 90
/** The ladder grows, and later folds away. */
export const LADDER_GROW_MS = 500
export const LADDER_FOLD_MS = 400
/** How far a ladder's rails reach above the edge it leans on. */
export const LADDER_OVER = 6
/** Floating up, in CSS px per second. */
export const BALLOON_SPEED = 80
/** The most it rises at once, and the least (in pet heights). */
export const BALLOON_MAX_RISE = 360
export const BALLOON_MIN_RISE = 1.5
/** The most it drifts sideways while rising, in CSS px. */
export const BALLOON_DRIFT = 80
/** How long it hovers up there before the balloon pops: [min, max] in ms. */
export const BALLOON_HOVER_MS: [number, number] = [3000, 6000]
/** The pop frame shows this long; a balloon let go floats off for BALLOON_AWAY_MS. */
export const BALLOON_POP_MS = 260
export const BALLOON_AWAY_MS = 700
/** Falling: gravity and the fastest it gets, in CSS px per second (squared). */
export const GRAVITY = 3000
export const FALL_MAX_SPEED = 1100
/** The squash after landing, and how long the dust puff stays (match --pet-land, --pet-dust). */
export const LAND_MS = 300
export const DUST_MS = 550

/** What it can do to change height. A jump is the short hop; `null` is the ground. */
export type LiftChoice =
  | { type: 'stay' }
  | { type: 'jump'; ledge: Ledge | null }
  | { type: 'ladder'; ledge: Ledge | null }
  | { type: 'balloon'; plan: BalloonPlan }

export interface LiftContext {
  movement: PetMovement
  /** May use other windows (the setting). Without it only the ground is a place to stand. */
  climb: boolean
  /** Ladders and balloons (the setting). */
  toys: boolean
  reducedMotion: boolean
  /** An agent is running: it works and walks with its laptop, never climbs a ladder or floats. */
  busy: boolean
  /** Dragged, its menu open, a bubble up, a question waiting, or already mid-move. */
  held: boolean
  /** Standing on a window's edge. */
  perched: boolean
  /** The pet's left edge and top. */
  x: number
  y: number
  /** The top it has when it stands on the ground. */
  groundY: number
  ledges: Ledge[]
  pet: { width: number; height: number }
  area: { width: number; height: number }
}

/** Whether it may start any change of height now. */
export function liftsAllowed(ctx: Pick<LiftContext, 'movement' | 'reducedMotion' | 'held'>): boolean {
  return ctx.movement !== 'still' && !ctx.reducedMotion && !ctx.held
}

/** Whether a drop in mid-air falls to the nearest surface (else it stays where dropped). */
export function dropFalls(ctx: { movement: PetMovement; climb: boolean; reducedMotion: boolean }): boolean {
  return ctx.climb && ctx.movement !== 'still' && !ctx.reducedMotion
}

/** Room above the pet a balloon and its string take. */
export function balloonRoom(petWidth: number): number {
  return Math.ceil(petWidth * 0.8) + 4
}

/** The highest top the pet floats to: the balloon stays inside the screen. */
export function balloonMinY(areaHeight: number, pet: { width: number; height: number }): number {
  return clampY(balloonRoom(pet.width), areaHeight, pet.height)
}

export interface BalloonPlan {
  toX: number
  toY: number
  /** The window edge it steers to and steps onto, or null: it hovers, then the balloon pops. */
  ledge: Ledge | null
  hoverMs: number
}

/**
 * Where a balloon takes the pet: up by 1.5 pet heights or more (at most
 * BALLOON_MAX_RISE, never past the top room), drifting sideways a little,
 * sometimes to a window edge in reach. Null when there is no room to rise.
 * Calls `random` for the drift, then (with an edge in reach) the steering
 * choice, then the height (unless steering), then the hover time.
 */
export function balloonPlan(ctx: Pick<LiftContext, 'x' | 'y' | 'ledges' | 'pet' | 'area' | 'climb'>, random: () => number): BalloonPlan | null {
  const { pet, area } = ctx
  const lowest = ctx.y - pet.height * BALLOON_MIN_RISE
  const highest = Math.max(balloonMinY(area.height, pet), ctx.y - BALLOON_MAX_RISE)
  if (lowest < highest) return null
  const drift = (random() * 2 - 1) * BALLOON_DRIFT
  let toX = clampX(ctx.x + drift, area.width, pet.width)
  let toY: number | null = null
  let ledge: Ledge | null = null
  const standOn = (l: Ledge) => Math.min(Math.max(toX, l.x), l.x + l.width - pet.width)
  const near = ctx.climb
    ? ctx.ledges.filter((l) => l.y - pet.height >= highest && l.y - pet.height <= lowest && Math.abs(standOn(l) - ctx.x) <= BALLOON_DRIFT * 1.5)
    : []
  if (near.length > 0 && random() < BALLOON_LEDGE_CHANCE) {
    ledge = near.reduce((best, l) => (Math.abs(standOn(l) - toX) < Math.abs(standOn(best) - toX) ? l : best))
    toX = standOn(ledge)
    toY = ledge.y - pet.height
  }
  if (toY === null) toY = highest + random() * (lowest - highest)
  const [min, max] = BALLOON_HOVER_MS
  return { toX, toY, ledge, hoverMs: min + random() * (max - min) }
}

/**
 * How it changes height after a sit: nothing, a jump (short), a ladder
 * (taller than LADDER_RISE pet heights, with the setting on and no agent
 * running) or a balloon. One roll picks, in bands: climbing first (the
 * nearest window above, or the way down from the one it stands on), then
 * the balloon. Calm and stay-put pets never climb windows. Reduced motion,
 * stay-put and a held pet never start any of them.
 */
export function chooseLift(ctx: LiftContext, random: () => number): LiftChoice {
  if (!liftsAllowed(ctx)) return { type: 'stay' }
  const roll = random()
  const playful = ctx.movement === 'playful' || ctx.movement === 'chaotic'
  const mayClimb = ctx.climb && playful
  const props = ctx.toys && !ctx.busy
  const tall = (rise: number) => rise > LADDER_RISE * ctx.pet.height
  let base = 0
  if (mayClimb && ctx.perched) {
    const ladder = props && tall(ctx.groundY - ctx.y)
    base = ladder ? LADDER_CHANCE[ctx.movement] : JUMP_DOWN_CHANCE
    if (roll < base) return { type: ladder ? 'ladder' : 'jump', ledge: null }
  } else if (mayClimb) {
    const above = ctx.ledges.filter((l) => l.y - ctx.pet.height < ctx.y - 4)
    if (above.length > 0) {
      const gap = (l: { x: number; width: number }) => Math.abs(l.x + l.width / 2 - ctx.x)
      const ledge = above.reduce((best, l) => (gap(l) < gap(best) ? l : best))
      const ladder = props && tall(ctx.y - (ledge.y - ctx.pet.height))
      base = ladder ? LADDER_CHANCE[ctx.movement] : CLIMB_CHANCE
      if (roll < base) return { type: ladder ? 'ladder' : 'jump', ledge }
    }
  }
  if (props && roll >= base && roll < base + BALLOON_CHANCE[ctx.movement]) {
    const plan = balloonPlan(ctx, random)
    if (plan) return { type: 'balloon', plan }
  }
  return { type: 'stay' }
}

/** The ladder's size and place: its feet at the lower stance, its rails over the upper edge. */
export function ladderBox(x: number, fromY: number, toY: number, pet: { width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const width = Math.round(pet.width * 0.34)
  const top = Math.min(fromY, toY) + pet.height - LADDER_OVER
  const bottom = Math.max(fromY, toY) + pet.height
  return { left: x + (pet.width - width) / 2, top, width, height: bottom - top }
}

/** How long a climb over `rise` px takes (never a flash). */
export function climbMs(rise: number): number {
  return Math.max(600, Math.round((Math.abs(rise) / CLIMB_SPEED) * 1000))
}

/** How long a float over `rise` px takes: unhurried, never dragging on. */
export function floatMs(rise: number): number {
  return Math.min(6000, Math.max(1200, Math.round((Math.abs(rise) / BALLOON_SPEED) * 1000)))
}

/** The distance in which a fall reaches its top speed. */
const FALL_RAMP = (FALL_MAX_SPEED * FALL_MAX_SPEED) / (2 * GRAVITY)

/** How long a fall over `distance` px takes: gravity, then a capped speed. */
export function fallMs(distance: number): number {
  const d = Math.max(0, distance)
  const seconds = d <= FALL_RAMP ? Math.sqrt((2 * d) / GRAVITY) : FALL_MAX_SPEED / GRAVITY + (d - FALL_RAMP) / FALL_MAX_SPEED
  return Math.round(seconds * 1000)
}

/** Whether the fall is long enough to reach its top speed (it eases in, then keeps the speed). */
export function fallCapped(distance: number): boolean {
  return distance > FALL_RAMP
}

/**
 * Where a pet at `at` lands: on the nearest window edge below it that its
 * middle is over (moved onto the edge if it hangs over), else the ground,
 * whose top is `groundY`. A pet already on or below that stays where it is.
 */
export function fallTarget(
  at: { x: number; y: number },
  all: Ledge[],
  groundY: number,
  pet: { width: number; height: number },
): { x: number; y: number; ledge: Ledge | null } {
  const middle = at.x + pet.width / 2
  let best: { x: number; y: number; ledge: Ledge | null } = { x: at.x, y: Math.max(groundY, at.y), ledge: null }
  for (const l of all) {
    const top = l.y - pet.height
    if (middle < l.x || middle > l.x + l.width || top < at.y - 1 || top >= best.y) continue
    best = { x: Math.min(Math.max(at.x, l.x), l.x + l.width - pet.width), y: top, ledge: l }
  }
  return best
}

// ── Pose ───────────────────────────────────────────────────────────────────

export type PetPose = 'walk' | 'sit' | 'sleep' | 'work' | 'alert' | 'hop' | 'droop' | 'look' | 'zoom' | 'pant' | 'climb' | 'float' | 'fall'

/** A short reaction to a notification, shown over the pose. */
export type PetReaction = 'hop' | 'droop' | 'look'

export function reactionFor(tone: BubbleTone): PetReaction | null {
  if (tone === 'done') return 'hop'
  if (tone === 'failed') return 'droop'
  if (tone === 'remind') return 'look'
  return null
}

export interface PoseInput {
  status: PetStatus
  reaction: PetReaction | null
  /** Between walks, or set to stay put. */
  sitting: boolean
  /** Being dragged, its menu open, or a bubble up: it stands still. */
  held?: boolean
  zoom?: ZoomPhase | null
  /** Mid ladder, balloon or fall: the pose of that move (it sits while a ladder grows or folds). */
  lift?: 'sit' | 'climb' | 'float' | 'fall' | null
  idleMs: number
  reducedMotion: boolean
  movement: PetMovement
}

/**
 * What the pet does: a waiting question first, then a fresh reaction,
 * then working while an agent runs (at its laptop when sitting, carrying it
 * when walking); otherwise it runs about (zoomies), wanders, sits, and
 * sleeps after a long quiet spell.
 */
export function petPose({ status, reaction, sitting, held = false, zoom = null, lift = null, idleMs, reducedMotion, movement }: PoseInput): PetPose {
  if (status.needsInput > 0) return 'alert'
  if (lift && !reducedMotion && movement !== 'still') return lift
  if (reaction) return reaction
  if (status.running > 0) return reducedMotion || movement === 'still' || held || sitting ? 'work' : 'walk'
  if (idleMs >= SLEEP_AFTER_MS) return 'sleep'
  if (reducedMotion || movement === 'still' || held) return 'sit'
  if (zoom === 'run') return 'zoom'
  if (zoom === 'pant') return 'pant'
  if (sitting) return 'sit'
  return 'walk'
}

// ── Bubbles ────────────────────────────────────────────────────────────────

export interface BubbleState {
  /** Questions waiting on the user, oldest first. They stay until answered. */
  questions: PetBubble[]
  /** Questions put off with "Later": folded behind the badge, still waiting. */
  later: string[]
  /** The finished turn or reminder on show; it fades into `unread`. */
  current: PetBubble | null
  /** Faded or crowded-out bubbles, newest first, behind the badge. */
  unread: PetBubble[]
  /** The unread list is open (the pet was clicked). */
  listOpen: boolean
}

export const EMPTY_BUBBLES: BubbleState = { questions: [], later: [], current: null, unread: [], listOpen: false }

export type BubbleAction =
  | { type: 'notify'; bubble: PetBubble }
  | { type: 'fade'; id: string }
  | { type: 'dismiss'; id: string }
  | { type: 'showQuestion'; id: string }
  | { type: 'answered'; key: string }
  | { type: 'readSession'; key: string }
  | { type: 'status'; status: PetStatus }
  | { type: 'toggleList' }
  | { type: 'clearUnread' }
  | { type: 'clear' }

function pushUnread(unread: PetBubble[], bubble: PetBubble): PetBubble[] {
  return [bubble, ...unread.filter((u) => u.id !== bubble.id)].slice(0, MAX_UNREAD)
}

/** The question on the stage: the first one not put off. */
export function shownQuestion(state: Pick<BubbleState, 'questions' | 'later'>): PetBubble | null {
  return state.questions.find((q) => !state.later.includes(q.id)) ?? null
}

/** The questions folded behind the badge. */
export function hiddenQuestions(state: Pick<BubbleState, 'questions' | 'later'>): PetBubble[] {
  const shown = shownQuestion(state)
  return state.questions.filter((q) => q !== shown)
}

export function bubbleReducer(state: BubbleState, action: BubbleAction): BubbleState {
  switch (action.type) {
    case 'notify': {
      const { bubble } = action
      if (state.questions.some((q) => q.id === bubble.id) || state.current?.id === bubble.id) return state
      if (bubble.tone === 'input') {
        // One question per session: a newer one replaces it (and is new, so
        // it shows even if the one it replaces was put off).
        const replaced = state.questions.filter((q) => bubble.sessionId && q.sessionId === bubble.sessionId).map((q) => q.id)
        const questions = [...state.questions.filter((q) => !replaced.includes(q.id)), bubble]
        const later = state.later.filter((id) => !replaced.includes(id))
        // A question takes the stage; what was on show waits behind the badge.
        const unread = state.current ? pushUnread(state.unread, state.current) : state.unread
        return { ...state, questions, later, current: null, unread, listOpen: false }
      }
      if (shownQuestion(state)) return { ...state, unread: pushUnread(state.unread, bubble) }
      const unread = state.current ? pushUnread(state.unread, state.current) : state.unread
      return { ...state, current: bubble, unread, listOpen: false }
    }
    case 'fade': {
      if (state.current?.id !== action.id) return state
      return { ...state, current: null, unread: pushUnread(state.unread, state.current) }
    }
    case 'dismiss': {
      // A question is never lost by dismissing it: "Later" folds it behind
      // the badge, where it waits until it is answered.
      if (state.questions.some((q) => q.id === action.id)) {
        return state.later.includes(action.id) ? state : { ...state, later: [...state.later, action.id], listOpen: false }
      }
      const unread = state.unread.filter((u) => u.id !== action.id)
      return {
        ...state,
        current: state.current?.id === action.id ? null : state.current,
        unread,
        listOpen: state.listOpen && unread.length + state.questions.length > 0,
      }
    }
    case 'showQuestion': {
      const question = state.questions.find((q) => q.id === action.id)
      if (!question) return state
      return {
        ...state,
        questions: [question, ...state.questions.filter((q) => q.id !== action.id)],
        later: state.later.filter((id) => id !== action.id),
        listOpen: false,
      }
    }
    case 'answered': {
      // Answered here or anywhere: the question is gone from every surface.
      const answered = state.questions.filter((q) => q.sessionId && sessionKey(q.sessionId) === action.key).map((q) => q.id)
      if (answered.length === 0) return state
      const questions = state.questions.filter((q) => !answered.includes(q.id))
      const unread = state.unread
      return {
        ...state,
        questions,
        later: state.later.filter((id) => !answered.includes(id)),
        listOpen: state.listOpen && unread.length + questions.length > 0,
      }
    }
    case 'readSession': {
      // Read somewhere else: its finished turns and reminders go; a question
      // still waits on the user until it is answered.
      const about = (b: PetBubble | null) => Boolean(b?.sessionId && sessionKey(b.sessionId) === action.key)
      if (!about(state.current) && !state.unread.some(about)) return state
      const unread = state.unread.filter((u) => !about(u))
      return {
        ...state,
        current: about(state.current) ? null : state.current,
        unread,
        listOpen: state.listOpen && unread.length + state.questions.length > 0,
      }
    }
    case 'status':
      // Nothing waits on the user any more: the questions were answered.
      return action.status.needsInput === 0 && state.questions.length > 0 ? { ...state, questions: [], later: [] } : state
    case 'toggleList':
      return { ...state, listOpen: !state.listOpen && state.unread.length + state.questions.length > 0 }
    case 'clearUnread':
      // Finished turns and reminders only: a question still waits on you.
      return { ...state, current: null, unread: [], listOpen: false }
    case 'clear':
      return EMPTY_BUBBLES
  }
}

export type VisibleBubble =
  | { type: 'bubble'; bubble: PetBubble; fades: boolean }
  | { type: 'list'; questions: PetBubble[]; unread: PetBubble[] }
  | null

/** What shows above the pet: the open list, a question not put off, or the latest bubble. */
export function visibleBubble(state: BubbleState): VisibleBubble {
  if (state.listOpen && state.unread.length + state.questions.length > 0) {
    return { type: 'list', questions: state.questions, unread: state.unread }
  }
  const question = shownQuestion(state)
  if (question) return { type: 'bubble', bubble: question, fades: false }
  if (state.current) return { type: 'bubble', bubble: state.current, fades: true }
  return null
}

/** The badge count on the pet: unread bubbles plus questions behind the one on show (or put off). */
export function badgeCount(state: BubbleState): number {
  return state.unread.length + hiddenQuestions(state).length
}

/** What the badge says in words (it is a button): which of its items need you. */
export function badgeLabel(state: BubbleState): string {
  const waiting = hiddenQuestions(state).length
  const parts = [
    waiting > 0 ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : '',
    state.unread.length > 0 ? `${state.unread.length} unread` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

/**
 * The dismissed bubbles whose sessions are then read everywhere: finished
 * turns and reminders about a session. Dismissing a question only hides it.
 */
export function readOnDismiss(bubbles: PetBubble[]): string[] {
  return bubbles.filter((b) => b.sessionId && b.tone !== 'input').map((b) => b.id)
}

// ── Placement ──────────────────────────────────────────────────────────────

/** Keep the pet inside the display, left to right. */
export function clampX(x: number, stripWidth: number, petWidth: number): number {
  const max = Math.max(0, stripWidth - petWidth)
  if (!Number.isFinite(x)) return 0
  return Math.min(Math.max(0, x), max)
}

/** A bubble's left edge: over the pet, kept inside the strip. */
export function bubbleLeft(petX: number, stripWidth: number): number {
  return Math.round(Math.min(Math.max(8, petX - 12), Math.max(8, stripWidth - BUBBLE_WIDTH - 8)))
}

/** The pet's starting x from a saved 0..1 position (default: a third of the way). */
export function startX(position: PetSettings['position'], stripWidth: number, petWidth: number): number {
  const fraction = position && Number.isFinite(position.x) ? position.x : 0.3
  return clampX(fraction * stripWidth, stripWidth, petWidth)
}

/** Keep the pet's top inside the display, with room above it for its marks. */
export function clampY(y: number, areaHeight: number, petHeight: number): number {
  const max = Math.max(0, areaHeight - petHeight)
  const min = Math.min(TOP_ROOM, max)
  if (!Number.isFinite(y)) return max
  return Math.min(Math.max(min, y), max)
}

/** The pet's starting top from a saved 0..1 feet height (default: the bottom edge). */
export function startY(position: PetSettings['position'], areaHeight: number, petHeight: number): number {
  const fraction = position && typeof position.y === 'number' && Number.isFinite(position.y) ? position.y : 1
  return clampY(fraction * areaHeight - petHeight, areaHeight, petHeight)
}

/** Whether the bubble opens below the pet: too near the top for it to fit above. */
export function bubbleBelow(petY: number): boolean {
  return petY < BUBBLE_ROOM
}

/** The next spot to walk to: somewhere else along the strip, at least `minStep` away. */
export function nextTarget(x: number, stripWidth: number, petWidth: number, random: number, minStep = 80): number {
  const max = Math.max(0, stripWidth - petWidth)
  if (max <= minStep) return clampX(x, stripWidth, petWidth)
  let target = random * max
  if (Math.abs(target - x) < minStep) target = x + (target >= x ? minStep : -minStep)
  if (target < 0 || target > max) target = x - (target - x)
  return clampX(target, stripWidth, petWidth)
}

// ── The window's frame ─────────────────────────────────────────────────────

/** The work area, in CSS px: the world the pet lives in ("area" pixels). */
export interface PetArea {
  width: number
  height: number
}

/** What the shell tells the page about its window: the area, and the window's box in it. */
export interface PetFrameView {
  area: PetArea
  frame: Box
}

/**
 * The window is a lane of the work area: the full width and only as tall as
 * the pet's scene needs (the shell moves it; see pet.rs). Room kept above
 * the pet for its marks and its poke reply, and below its feet (the same
 * numbers as FRAME_ABOVE and FRAME_BELOW in pet.rs).
 */
export const FRAME_ABOVE = 56
export const FRAME_BELOW = 12
/** A bigger frame than needed is kept until this long after the need shrank. */
export const FRAME_SHRINK_AFTER_MS = 1500
/** Shrinking for less than this many px is not worth moving the window. */
export const FRAME_SHRINK_MIN = 24
/** After the shell says the window moved, the pet stays hidden this long so no half-moved frame shows. */
export const FRAME_SETTLE_MS = 90
/** A move that starts only once the window has the room waits at most this long for the shell. */
export const FRAME_WAIT_MS = 400

/** A box seen from the window (its own pixels) in area pixels, given the window's origin in the area. */
export function toArea(box: Box, origin: { x: number; y: number }): Box {
  return { x: box.x + origin.x, y: box.y + origin.y, width: box.width, height: box.height }
}

/** The whole area: what the window is while the pet is dragged. */
export function fullFrame(area: PetArea): Box {
  return { x: 0, y: 0, width: area.width, height: area.height }
}

/** A full-width lane from `top` to `bottom` (area px), inside the area, in whole pixels. */
export function laneFrame(top: number, bottom: number, area: PetArea): Box {
  const lo = Math.min(Math.max(Math.floor(top), 0), Math.max(0, area.height - 1))
  const hi = Math.min(Math.max(Math.ceil(bottom), lo + 1), area.height)
  return { x: 0, y: lo, width: area.width, height: Math.max(1, hi - lo) }
}

export interface SceneInput {
  area: PetArea
  /** The pet's box where it is going (its target, in area px). */
  pet: Box
  /** The pet's whole path in a move under way (a climb, a float, a fall, a jump), or null. */
  reach: Box | null
  /** What else is drawn: a bubble, the badge, the balloon, the ladder (area px). */
  rects: Box[]
  /** Being dragged: the pet may be dropped anywhere. */
  dragging: boolean
}

/** The frame the window needs now: a lane round the scene, or all of the area while dragged. */
export function neededFrame({ area, pet, reach, rects, dragging }: SceneInput): Box {
  if (dragging) return fullFrame(area)
  // The pet anywhere on its path needs the same room round it as where it stands.
  const stands = [pet, ...(reach ? [reach] : [])]
  const top = Math.min(...stands.map((b) => b.y - FRAME_ABOVE), ...rects.map((b) => b.y))
  const bottom = Math.max(...stands.map((b) => b.y + b.height + FRAME_BELOW), ...rects.map((b) => b.y + b.height))
  return laneFrame(top, bottom, area)
}

/** Whether `frame` holds all of `need` (within a pixel). */
export function frameCovers(frame: Box, need: Box, tolerance = 1): boolean {
  return (
    need.x >= frame.x - tolerance &&
    need.y >= frame.y - tolerance &&
    need.x + need.width <= frame.x + frame.width + tolerance &&
    need.y + need.height <= frame.y + frame.height + tolerance
  )
}

/** The smallest frame holding both. */
export function growFrame(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

/** Whether a frame holding `need` is big enough, by a good margin, to be worth shrinking to it. */
export function shrinkable(frame: Box, need: Box): boolean {
  return frameCovers(frame, need) && frame.width * frame.height - need.width * need.height >= FRAME_SHRINK_MIN * Math.min(frame.width, need.width)
}

/**
 * Whether going from `from` to `to` moves the window's top-left corner. A
 * webview keeps showing its old picture, anchored there, until it has
 * redrawn at the new size: the pet is hidden across such a move.
 */
export function originMoves(from: Box, to: Box): boolean {
  return Math.abs(from.x - to.x) > 0.5 || Math.abs(from.y - to.y) > 0.5
}
