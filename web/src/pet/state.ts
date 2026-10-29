/**
 * The desktop pet's data, as the desktop shell sends it
 * (desktop/src-tauri/src/pet.rs), and the pure decisions about what it does:
 * its pose, and which bubble shows.
 */

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

/** Ms until the next bout on its own, or null when it never runs about unasked. */
export function zoomDelay(movement: PetMovement, random: number): number | null {
  if (movement !== 'chaotic') return null
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

// ── Pose ───────────────────────────────────────────────────────────────────

export type PetPose = 'walk' | 'sit' | 'sleep' | 'work' | 'alert' | 'hop' | 'droop' | 'look' | 'zoom' | 'pant'

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
  idleMs: number
  reducedMotion: boolean
  movement: PetMovement
}

/**
 * What the pet does: a waiting question first, then a fresh reaction,
 * then working while an agent runs; otherwise it runs about (zoomies),
 * wanders, sits, and sleeps after a long quiet spell.
 */
export function petPose({ status, reaction, sitting, held = false, zoom = null, idleMs, reducedMotion, movement }: PoseInput): PetPose {
  if (status.needsInput > 0) return 'alert'
  if (reaction) return reaction
  if (status.running > 0) return 'work'
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
  /** The finished turn or reminder on show; it fades into `unread`. */
  current: PetBubble | null
  /** Faded or crowded-out bubbles, newest first, behind the badge. */
  unread: PetBubble[]
  /** The unread list is open (the pet was clicked). */
  listOpen: boolean
}

export const EMPTY_BUBBLES: BubbleState = { questions: [], current: null, unread: [], listOpen: false }

export type BubbleAction =
  | { type: 'notify'; bubble: PetBubble }
  | { type: 'fade'; id: string }
  | { type: 'dismiss'; id: string }
  | { type: 'status'; status: PetStatus }
  | { type: 'toggleList' }
  | { type: 'clearUnread' }
  | { type: 'clear' }

function pushUnread(unread: PetBubble[], bubble: PetBubble): PetBubble[] {
  return [bubble, ...unread.filter((u) => u.id !== bubble.id)].slice(0, MAX_UNREAD)
}

export function bubbleReducer(state: BubbleState, action: BubbleAction): BubbleState {
  switch (action.type) {
    case 'notify': {
      const { bubble } = action
      if (state.questions.some((q) => q.id === bubble.id) || state.current?.id === bubble.id) return state
      if (bubble.tone === 'input') {
        // One question per session: a newer one replaces it.
        const questions = [...state.questions.filter((q) => !bubble.sessionId || q.sessionId !== bubble.sessionId), bubble]
        // A question takes the stage; what was on show waits behind the badge.
        const unread = state.current ? pushUnread(state.unread, state.current) : state.unread
        return { ...state, questions, current: null, unread, listOpen: false }
      }
      if (state.questions.length > 0) return { ...state, unread: pushUnread(state.unread, bubble) }
      const unread = state.current ? pushUnread(state.unread, state.current) : state.unread
      return { ...state, current: bubble, unread, listOpen: false }
    }
    case 'fade': {
      if (state.current?.id !== action.id) return state
      return { ...state, current: null, unread: pushUnread(state.unread, state.current) }
    }
    case 'dismiss': {
      const unread = state.unread.filter((u) => u.id !== action.id)
      return {
        questions: state.questions.filter((q) => q.id !== action.id),
        current: state.current?.id === action.id ? null : state.current,
        unread,
        listOpen: state.listOpen && unread.length > 0,
      }
    }
    case 'status':
      // Nothing waits on the user any more: the questions were answered.
      return action.status.needsInput === 0 && state.questions.length > 0 ? { ...state, questions: [] } : state
    case 'toggleList':
      return { ...state, listOpen: !state.listOpen && state.unread.length > 0 }
    case 'clearUnread':
      // Finished turns and reminders only: a question still waits on you.
      return { ...state, current: null, unread: [], listOpen: false }
    case 'clear':
      return EMPTY_BUBBLES
  }
}

export type VisibleBubble =
  | { type: 'bubble'; bubble: PetBubble; fades: boolean }
  | { type: 'list'; items: PetBubble[] }
  | null

/** What shows above the pet: the open list, a waiting question, or the latest bubble. */
export function visibleBubble(state: BubbleState): VisibleBubble {
  if (state.listOpen && state.unread.length > 0) return { type: 'list', items: state.unread }
  if (state.questions[0]) return { type: 'bubble', bubble: state.questions[0], fades: false }
  if (state.current) return { type: 'bubble', bubble: state.current, fades: true }
  return null
}

/** The badge count on the pet: unread bubbles plus questions behind the one on show. */
export function badgeCount(state: BubbleState): number {
  return state.unread.length + Math.max(0, state.questions.length - 1)
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
