import { describe, expect, it } from 'bun:test'
import {
  BUBBLE_WIDTH,
  EMPTY_BUBBLES,
  MAX_UNREAD,
  SLEEP_AFTER_MS,
  badgeCount,
  bubbleLeft,
  bubbleReducer,
  clampX,
  nextTarget,
  petPose,
  reactionFor,
  startX,
  visibleBubble,
  type BubbleState,
  type BubbleTone,
  type PetBubble,
  type PoseInput,
} from '@/pet/state'

const bubble = (id: string, tone: BubbleTone, sessionId: string | null = `s-${id}`): PetBubble => ({
  id,
  kind: tone === 'input' ? 'input_needed' : tone === 'remind' ? 'reminder_fired' : 'assistant_done',
  tone,
  sessionId,
  title: `Title ${id}`,
  body: `Body ${id}`,
})

const notify = (state: BubbleState, b: PetBubble) => bubbleReducer(state, { type: 'notify', bubble: b })

describe('petPose', () => {
  const base: PoseInput = {
    status: { running: 0, needsInput: 0 },
    reaction: null,
    sitting: false,
    idleMs: 0,
    reducedMotion: false,
    movement: 'calm',
  }

  it('wanders when nothing runs', () => {
    expect(petPose(base)).toBe('walk')
    expect(petPose({ ...base, sitting: true })).toBe('sit')
  })

  it('works while an agent runs and raises an alert when one waits on you', () => {
    expect(petPose({ ...base, status: { running: 1, needsInput: 0 } })).toBe('work')
    expect(petPose({ ...base, status: { running: 1, needsInput: 1 }, reaction: 'hop' })).toBe('alert')
  })

  it('reacts to a notification before going back to work', () => {
    expect(petPose({ ...base, status: { running: 2, needsInput: 0 }, reaction: 'droop' })).toBe('droop')
  })

  it('falls asleep after a long quiet spell', () => {
    expect(petPose({ ...base, idleMs: SLEEP_AFTER_MS - 1 })).toBe('walk')
    expect(petPose({ ...base, idleMs: SLEEP_AFTER_MS })).toBe('sleep')
  })

  it('stays put when told to or when motion is reduced', () => {
    expect(petPose({ ...base, movement: 'still' })).toBe('sit')
    expect(petPose({ ...base, reducedMotion: true })).toBe('sit')
  })

  it('hops for a finished turn, droops for a failed one, and looks up for a reminder', () => {
    expect(reactionFor('done')).toBe('hop')
    expect(reactionFor('failed')).toBe('droop')
    expect(reactionFor('remind')).toBe('look')
    expect(reactionFor('input')).toBeNull()
  })
})

describe('bubbleReducer', () => {
  it('shows a finished turn, then fades it behind the badge', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    expect(visibleBubble(state)).toEqual({ type: 'bubble', bubble: bubble('a', 'done'), fades: true })
    state = bubbleReducer(state, { type: 'fade', id: 'a' })
    expect(visibleBubble(state)).toBeNull()
    expect(badgeCount(state)).toBe(1)
  })

  it('keeps a question on show until it is answered', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q', 'input'))
    expect(visibleBubble(state)).toEqual({ type: 'bubble', bubble: bubble('q', 'input'), fades: false })
    state = bubbleReducer(state, { type: 'fade', id: 'q' })
    expect(visibleBubble(state)).not.toBeNull()
    state = bubbleReducer(state, { type: 'status', status: { running: 1, needsInput: 1 } })
    expect(visibleBubble(state)).not.toBeNull()
    state = bubbleReducer(state, { type: 'status', status: { running: 1, needsInput: 0 } })
    expect(visibleBubble(state)).toBeNull()
  })

  it('lets a question take the stage and queues what arrives behind it', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    state = notify(state, bubble('q', 'input'))
    expect(visibleBubble(state)).toMatchObject({ bubble: { id: 'q' } })
    state = notify(state, bubble('r', 'remind'))
    expect(visibleBubble(state)).toMatchObject({ bubble: { id: 'q' } })
    expect(state.unread.map((u) => u.id)).toEqual(['r', 'a'])
    expect(badgeCount(state)).toBe(2)
  })

  it('keeps one question per session', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q1', 'input', 's1'))
    state = notify(state, bubble('q2', 'input', 's1'))
    state = notify(state, bubble('q3', 'input', 's2'))
    expect(state.questions.map((q) => q.id)).toEqual(['q2', 'q3'])
    expect(badgeCount(state)).toBe(1)
  })

  it('moves the bubble on show behind the badge when a newer one arrives', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    state = notify(state, bubble('b', 'failed'))
    expect(visibleBubble(state)).toMatchObject({ bubble: { id: 'b' } })
    expect(state.unread.map((u) => u.id)).toEqual(['a'])
  })

  it('ignores a notification it already has', () => {
    const state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    expect(notify(state, bubble('a', 'done'))).toBe(state)
  })

  it('caps the unread list', () => {
    let state = EMPTY_BUBBLES
    for (let i = 0; i < MAX_UNREAD + 3; i += 1) state = notify(state, bubble(`b${i}`, 'done'))
    expect(state.unread).toHaveLength(MAX_UNREAD)
  })

  it('opens the unread list on a click and closes it when it empties', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    state = bubbleReducer(state, { type: 'toggleList' })
    expect(state.listOpen).toBe(false)
    state = bubbleReducer(state, { type: 'fade', id: 'a' })
    state = bubbleReducer(state, { type: 'toggleList' })
    expect(visibleBubble(state)).toEqual({ type: 'list', items: [bubble('a', 'done')] })
    state = bubbleReducer(state, { type: 'dismiss', id: 'a' })
    expect(state.listOpen).toBe(false)
    expect(visibleBubble(state)).toBeNull()
  })

  it('dismisses a bubble wherever it is', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q', 'input'))
    state = notify(state, bubble('a', 'done'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'q' })
    state = bubbleReducer(state, { type: 'dismiss', id: 'a' })
    expect(state).toEqual(EMPTY_BUBBLES)
  })

  it('clears everything when the pet is turned off', () => {
    const state = notify(notify(EMPTY_BUBBLES, bubble('q', 'input')), bubble('a', 'done'))
    expect(bubbleReducer(state, { type: 'clear' })).toEqual(EMPTY_BUBBLES)
  })
})

describe('placement', () => {
  it('keeps the pet inside the strip', () => {
    expect(clampX(-10, 1000, 64)).toBe(0)
    expect(clampX(5000, 1000, 64)).toBe(936)
    expect(clampX(Number.NaN, 1000, 64)).toBe(0)
  })

  it('starts where it was dropped, or a third of the way along', () => {
    expect(startX({ display: 'LG', x: 0.5 }, 1000, 64)).toBe(500)
    expect(startX(null, 900, 64)).toBe(270)
    expect(startX({ display: 'LG', x: 1 }, 1000, 64)).toBe(936)
  })

  it('keeps a bubble above the pet and on screen', () => {
    expect(bubbleLeft(200, 1000)).toBe(188)
    expect(bubbleLeft(0, 1000)).toBe(8)
    expect(bubbleLeft(990, 1000)).toBe(1000 - BUBBLE_WIDTH - 8)
  })

  it('walks somewhere else, at least a step away', () => {
    for (const random of [0, 0.1, 0.5, 0.52, 0.9, 1]) {
      const target = nextTarget(500, 1000, 64, random)
      expect(target).toBeGreaterThanOrEqual(0)
      expect(target).toBeLessThanOrEqual(936)
      expect(Math.abs(target - 500)).toBeGreaterThanOrEqual(80)
    }
    expect(nextTarget(10, 100, 64, 0.9)).toBe(10)
  })
})
