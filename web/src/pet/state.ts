/**
 * The desktop pet's data, as the desktop shell sends it
 * (desktop/src-tauri/src/pet.rs), and the pure decisions about what it does:
 * its pose, and which bubble shows.
 */

export type PetCharacter = 'cat'
export type PetColour = 'orange' | 'paper' | 'bark' | 'blue'
export type PetSize = 'small' | 'medium' | 'large'
export type PetMovement = 'still' | 'calm' | 'playful'

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
  hideInFullscreen: boolean
  /** Where it was dropped: a display, and 0..1 along its bottom edge. */
  position: { display: string; x: number } | null
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
  hideInFullscreen: true,
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
/** A finished turn or a reminder fades after this long. */
export const BUBBLE_FADE_MS = 8000
/** Unread bubbles kept behind the badge. */
export const MAX_UNREAD = 6
/** Nothing happening for this long and the pet curls up to sleep. */
export const SLEEP_AFTER_MS = 5 * 60 * 1000

export const SIZE_SCALE: Record<PetSize, number> = { small: 0.75, medium: 1, large: 1.4 }

/** Walking speed in CSS px per second; 0 stays put. */
export const WALK_SPEED: Record<PetMovement, number> = { still: 0, calm: 28, playful: 72 }

/** How long it sits between walks, in ms: [min, max]. */
export const SIT_PAUSE: Record<PetMovement, [number, number]> = {
  still: [Infinity, Infinity],
  calm: [4000, 10000],
  playful: [1000, 3500],
}

// ── Pose ───────────────────────────────────────────────────────────────────

export type PetPose = 'walk' | 'sit' | 'sleep' | 'work' | 'alert' | 'hop' | 'droop' | 'look'

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
  idleMs: number
  reducedMotion: boolean
  movement: PetMovement
}

/**
 * What the pet does: a waiting question first, then a fresh reaction,
 * then working while an agent runs; otherwise it wanders, sits, and sleeps
 * after a long quiet spell.
 */
export function petPose({ status, reaction, sitting, idleMs, reducedMotion, movement }: PoseInput): PetPose {
  if (status.needsInput > 0) return 'alert'
  if (reaction) return reaction
  if (status.running > 0) return 'work'
  if (idleMs >= SLEEP_AFTER_MS) return 'sleep'
  if (reducedMotion || movement === 'still' || sitting) return 'sit'
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

/** Keep the pet inside the strip. */
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

/** The next spot to walk to: somewhere else along the strip, at least `minStep` away. */
export function nextTarget(x: number, stripWidth: number, petWidth: number, random: number, minStep = 80): number {
  const max = Math.max(0, stripWidth - petWidth)
  if (max <= minStep) return clampX(x, stripWidth, petWidth)
  let target = random * max
  if (Math.abs(target - x) < minStep) target = x + (target >= x ? minStep : -minStep)
  if (target < 0 || target > max) target = x - (target - x)
  return clampX(target, stripWidth, petWidth)
}
