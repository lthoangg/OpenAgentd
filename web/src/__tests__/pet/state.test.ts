import { describe, expect, it } from 'bun:test'
import {
  BUBBLE_ROOM,
  BUBBLE_WIDTH,
  EMPTY_BUBBLES,
  MAX_UNREAD,
  SLEEP_AFTER_MS,
  TOP_ROOM,
  badgeCount,
  badgeLabel,
  bubbleBelow,
  bubbleLeft,
  bubbleReducer,
  clampX,
  clampY,
  followLedge,
  ledges,
  nextTarget,
  petPose,
  reactionFor,
  readOnDismiss,
  shownQuestion,
  sitPause,
  startX,
  startY,
  visibleBubble,
  withinPounce,
  zoomDelay,
  zoomsWhenDone,
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

  it('works at its laptop while an agent runs and raises an alert when one waits on you', () => {
    expect(petPose({ ...base, sitting: true, status: { running: 1, needsInput: 0 } })).toBe('work')
    expect(petPose({ ...base, status: { running: 1, needsInput: 1 }, reaction: 'hop' })).toBe('alert')
  })

  it('still walks about while an agent runs, carrying the laptop', () => {
    const busy = { ...base, status: { running: 1, needsInput: 0 } }
    expect(petPose(busy)).toBe('walk')
    expect(petPose({ ...busy, movement: 'playful' })).toBe('walk')
    // Never falls asleep at work.
    expect(petPose({ ...busy, idleMs: SLEEP_AFTER_MS * 2 })).toBe('walk')
  })

  it('works sitting still when told to stay put, motion is reduced, or it is held', () => {
    const busy = { ...base, status: { running: 1, needsInput: 0 } }
    expect(petPose({ ...busy, movement: 'still' })).toBe('work')
    expect(petPose({ ...busy, reducedMotion: true })).toBe('work')
    expect(petPose({ ...busy, held: true })).toBe('work')
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

  it('dashes about during zoomies, then stands panting', () => {
    expect(petPose({ ...base, zoom: 'run' })).toBe('zoom')
    expect(petPose({ ...base, zoom: 'pant' })).toBe('pant')
    expect(petPose({ ...base, sitting: true, zoom: 'run' })).toBe('zoom')
  })

  it('never runs about while held, told to stay put, or with motion reduced', () => {
    expect(petPose({ ...base, zoom: 'run', held: true })).toBe('sit')
    expect(petPose({ ...base, zoom: 'run', movement: 'still' })).toBe('sit')
    expect(petPose({ ...base, zoom: 'run', reducedMotion: true })).toBe('sit')
    expect(petPose({ ...base, held: true })).toBe('sit')
  })

  it('lets work, questions and sleep win over zoomies', () => {
    expect(petPose({ ...base, zoom: 'run', status: { running: 1, needsInput: 0 } })).toBe('walk')
    expect(petPose({ ...base, zoom: 'run', sitting: true, status: { running: 1, needsInput: 0 } })).toBe('work')
    expect(petPose({ ...base, zoom: 'run', status: { running: 0, needsInput: 1 } })).toBe('alert')
  })
})

describe('sitPause', () => {
  it('is the movement level’s pause when idle', () => {
    expect(sitPause('calm', false)).toEqual([4000, 10000])
    expect(sitPause('playful', false)).toEqual([1000, 3500])
  })

  it('is twice as long, and at least six seconds, while an agent runs', () => {
    expect(sitPause('calm', true)).toEqual([8000, 20000])
    expect(sitPause('playful', true)).toEqual([6000, 10000])
    expect(sitPause('chaotic', true)).toEqual([6000, 10000])
    expect(sitPause('still', true)[0]).toBe(Infinity)
  })
})

describe('zoomies', () => {
  it('pounces only at a pointer close beside it', () => {
    const pet = { x: 100, y: 500, width: 64, height: 48 }
    expect(withinPounce(pet, { x: 200, y: 520 })).toBe(true)
    expect(withinPounce(pet, { x: 130, y: 520 })).toBe(false)
    expect(withinPounce(pet, { x: 400, y: 520 })).toBe(false)
    expect(withinPounce(pet, { x: 200, y: 300 })).toBe(false)
  })

  it('come on their own every one to two minutes, only when chaotic', () => {
    expect(zoomDelay('chaotic', 0)).toBe(60_000)
    expect(zoomDelay('chaotic', 0.999)).toBeLessThanOrEqual(120_000)
    for (const movement of ['still', 'calm', 'playful'] as const) expect(zoomDelay(movement, 0.5)).toBeNull()
  })

  it('never come on their own while an agent runs', () => {
    expect(zoomDelay('chaotic', 0, true)).toBeNull()
  })

  it('celebrate a finished turn when playful or chaotic', () => {
    expect(zoomsWhenDone('chaotic')).toBe(true)
    expect(zoomsWhenDone('playful')).toBe(true)
    expect(zoomsWhenDone('calm')).toBe(false)
    expect(zoomsWhenDone('still')).toBe(false)
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

  const waiting = (key: string, id = `waiting:${key}:`) => ({ id, sessionId: key, sessionKey: key, title: 'Needs you · api', body: `Asks ${key}` })
  const status = (keys: string[], held: string[] = []) => ({ running: 0, needsInput: keys.length, waiting: keys.map((k) => waiting(k)), held })

  // Two questions waiting, one answered in the app: its bubble used to stay
  // until nothing waited at all.
  it('drops the question of a session that stopped waiting, keeping the others', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q1', 'input', 's1'))
    state = notify(state, bubble('q2', 'input', 's2'))
    state = bubbleReducer(state, { type: 'status', status: status(['s1', 's2']) })
    expect(state.questions.map((q) => q.id)).toEqual(['q1', 'q2'])
    state = bubbleReducer(state, { type: 'status', status: status(['s2']) })
    expect(state.questions.map((q) => q.id)).toEqual(['q2'])
  })

  // A one-second outage emptied the list and every question bubble went with it.
  it('keeps the questions of a server that cannot be reached right now', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q1', 'input', 's1'))
    state = bubbleReducer(state, { type: 'status', status: status(['s1']) })
    state = bubbleReducer(state, { type: 'status', status: { ...status([], ['s1']), needsInput: 0 } })
    expect(state.questions.map((q) => q.id)).toEqual(['q1'])
    state = bubbleReducer(state, { type: 'status', status: status([]) })
    expect(state.questions).toEqual([])
  })

  it('keeps a question its notification brought before the list confirms it', () => {
    let state = bubbleReducer(EMPTY_BUBBLES, { type: 'status', status: status(['s2']) })
    state = notify(state, bubble('q1', 'input', 's1'))
    state = bubbleReducer(state, { type: 'status', status: status(['s2']) })
    expect(state.questions.map((q) => q.id)).toEqual(['q1'])
  })

  // A question that came while the pet was hidden (or before the page
  // loaded) left the alert pose with no bubble, badge or menu entry.
  it('adds a bubble for a waiting session it missed, once, and only with question bubbles on', () => {
    expect(bubbleReducer(EMPTY_BUBBLES, { type: 'status', status: status(['s1']) }).questions).toEqual([])
    let state = bubbleReducer(EMPTY_BUBBLES, { type: 'status', status: status(['s1']), addMissing: true })
    expect(state.questions).toHaveLength(1)
    expect(state.questions[0]).toMatchObject({ id: 'waiting:s1:', tone: 'input', sessionId: 's1', body: 'Asks s1' })
    expect(visibleBubble(state)).toMatchObject({ bubble: { id: 'waiting:s1:' } })
    // Its notification later replaces it rather than adding a second one.
    state = notify(state, bubble('q1', 'input', 'S-1'))
    expect(state.questions.map((q) => q.id)).toEqual(['q1'])
    // Put off with Later, it is not added again.
    state = bubbleReducer(state, { type: 'dismiss', id: 'q1' })
    const again = bubbleReducer(state, { type: 'status', status: status(['s1']), addMissing: true })
    expect(again.questions.map((q) => q.id)).toEqual(['q1'])
    expect(again.later).toEqual(['q1'])
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
    expect(visibleBubble(state)).toEqual({ type: 'list', questions: [], unread: [bubble('a', 'done')] })
    state = bubbleReducer(state, { type: 'dismiss', id: 'a' })
    expect(state.listOpen).toBe(false)
    expect(visibleBubble(state)).toBeNull()
  })

  it('dismisses a finished bubble wherever it is', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    state = notify(state, bubble('b', 'failed'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'b' })
    state = bubbleReducer(state, { type: 'dismiss', id: 'a' })
    expect(state).toEqual(EMPTY_BUBBLES)
  })

  // × on a question used to delete it: the pet still said "!", with nothing to open.
  it('never loses a question to a dismiss: Later folds it behind the badge until it is answered', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q', 'input'))
    state = notify(state, bubble('a', 'done'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'q' })
    expect(state.questions.map((q) => q.id)).toEqual(['q'])
    expect(state.later).toEqual(['q'])
    expect(shownQuestion(state)).toBeNull()
    expect(visibleBubble(state)).toBeNull()
    expect(badgeCount(state)).toBe(2)
    expect(bubbleReducer(state, { type: 'dismiss', id: 'q' })).toBe(state)

    // Only the answer (or nothing waiting any more) removes it.
    expect(bubbleReducer(state, { type: 'status', status: { running: 1, needsInput: 0 } })).toMatchObject({ questions: [], later: [] })
  })

  it('brings a folded question back to the stage from the list', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q1', 'input', 's1'))
    state = notify(state, bubble('q2', 'input', 's2'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'q1' })
    expect(shownQuestion(state)?.id).toBe('q2')
    state = bubbleReducer(state, { type: 'toggleList' })
    expect(visibleBubble(state)).toMatchObject({ type: 'list', questions: [{ id: 'q1' }, { id: 'q2' }] })
    state = bubbleReducer(state, { type: 'showQuestion', id: 'q1' })
    expect(state.listOpen).toBe(false)
    expect(visibleBubble(state)).toMatchObject({ type: 'bubble', bubble: { id: 'q1' } })
    expect(state.later).toEqual([])
    expect(bubbleReducer(state, { type: 'showQuestion', id: 'nope' })).toBe(state)
  })

  it('shows a newer question for a session even if the older one was put off', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q1', 'input', 's1'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'q1' })
    state = notify(state, bubble('q2', 'input', 's1'))
    expect(visibleBubble(state)).toMatchObject({ bubble: { id: 'q2' } })
    expect(state.later).toEqual([])
  })

  it('removes a question answered anywhere, by its session, in either id form', () => {
    let state = notify(EMPTY_BUBBLES, bubble('q1', 'input', 'AA-bb'))
    state = notify(state, bubble('q2', 'input', 'cc'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'q1' })
    state = bubbleReducer(state, { type: 'answered', key: 'aabb' })
    expect(state.questions.map((q) => q.id)).toEqual(['q2'])
    expect(state.later).toEqual([])
    expect(bubbleReducer(state, { type: 'answered', key: 'zz' })).toBe(state)
  })

  it('says in words what waits behind the badge', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    state = bubbleReducer(state, { type: 'fade', id: 'a' })
    expect(badgeLabel(state)).toBe('1 unread')
    state = notify(state, bubble('q', 'input'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'q' })
    expect(badgeLabel(state)).toBe('1 needs you, 1 unread')
    state = notify(state, bubble('p', 'input', 's-other'))
    state = bubbleReducer(state, { type: 'dismiss', id: 'p' })
    expect(badgeLabel(state)).toBe('2 need you, 1 unread')
    expect(badgeLabel(EMPTY_BUBBLES)).toBe('')
  })

  it('clears everything when the pet is turned off', () => {
    const state = notify(notify(EMPTY_BUBBLES, bubble('q', 'input')), bubble('a', 'done'))
    expect(bubbleReducer(state, { type: 'clear' })).toEqual(EMPTY_BUBBLES)
  })

  it('clears finished notifications but keeps questions still waiting on you', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done'))
    state = notify(state, bubble('b', 'done'))
    state = notify(state, bubble('q', 'input'))
    state = bubbleReducer(state, { type: 'toggleList' })
    const cleared = bubbleReducer(state, { type: 'clearUnread' })
    expect(cleared).toEqual({ ...EMPTY_BUBBLES, questions: [bubble('q', 'input')] })
  })

  it('drops what a session read elsewhere left, whatever form its id takes', () => {
    let state = notify(EMPTY_BUBBLES, bubble('a', 'done', 'AA-bb'))
    state = notify(state, bubble('b', 'done', 'cc'))
    state = notify(state, bubble('r', 'remind', 'aabb'))
    state = notify(state, bubble('q', 'input', 'aabb'))
    state = bubbleReducer(state, { type: 'toggleList' })
    state = bubbleReducer(state, { type: 'readSession', key: 'aabb' })
    expect(state.unread.map((u) => u.id)).toEqual(['b'])
    expect(state.questions.map((q) => q.id)).toEqual(['q'])
    expect(state.listOpen).toBe(true)
    state = bubbleReducer(state, { type: 'readSession', key: 'cc' })
    expect(state.listOpen).toBe(true)
    // The question is still listed, so the list stays; answering it empties it.
    expect(bubbleReducer(state, { type: 'answered', key: 'aabb' }).listOpen).toBe(false)
    expect(bubbleReducer(state, { type: 'readSession', key: 'zz' })).toBe(state)
  })

  it('reads the sessions of dismissed finished turns and reminders, not questions', () => {
    expect(readOnDismiss([bubble('a', 'done'), bubble('q', 'input'), bubble('r', 'remind'), bubble('x', 'failed', null)])).toEqual(['a', 'r'])
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

  it('stands at the height it was dropped, or on the bottom edge', () => {
    expect(startY({ display: 'LG', x: 0.5, y: 0.5 }, 1000, 48)).toBe(500 - 48)
    expect(startY(null, 1000, 48)).toBe(1000 - 48)
    expect(startY({ display: 'LG', x: 0.5 }, 1000, 48)).toBe(1000 - 48)
    expect(startY({ display: 'LG', x: 0.5, y: 0 }, 1000, 48)).toBe(TOP_ROOM)
  })

  it('keeps the pet and its marks on screen vertically', () => {
    expect(clampY(-10, 1000, 48)).toBe(TOP_ROOM)
    expect(clampY(5000, 1000, 48)).toBe(952)
    expect(clampY(Number.NaN, 1000, 48)).toBe(952)
    expect(clampY(10, 40, 48)).toBe(0)
  })

  it('opens a bubble below the pet when there is no room above it', () => {
    expect(bubbleBelow(BUBBLE_ROOM + 1)).toBe(false)
    expect(bubbleBelow(BUBBLE_ROOM - 1)).toBe(true)
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

describe('ledges', () => {
  const area = { width: 1600, height: 1000 }
  const pet = { width: 64, height: 48 }
  const win = (id: number, x: number, y: number, width = 600, height = 400) => ({ id, x, y, width, height })

  it('stands on the top edge of an open window', () => {
    expect(ledges([win(1, 100, 300)], area, pet)).toEqual([{ id: 1, x: 100, y: 300, width: 600 }])
  })

  it('needs room above the edge and never takes the ground or a window off screen', () => {
    expect(ledges([win(1, 100, 30)], area, pet)).toEqual([])
    expect(ledges([win(2, 100, 970)], area, pet)).toEqual([])
    expect(ledges([win(3, -400, 300)], area, pet)).toEqual([{ id: 3, x: 0, y: 300, width: 200 }])
  })

  it('leaves out the part a window in front covers, keeping the widest piece', () => {
    const front = win(9, 280, 150, 200, 400)
    expect(ledges([front, win(1, 100, 300)], area, pet)).toEqual([
      { id: 9, x: 280, y: 150, width: 200 },
      { id: 1, x: 480, y: 300, width: 220 },
    ])
  })

  it('drops an edge too short to walk on', () => {
    const front = win(9, 120, 100, 560, 500)
    expect(ledges([front, win(1, 100, 300)], area, pet).map((l) => l.id)).toEqual([9])
  })
})

describe('followLedge', () => {
  const pet = { width: 64, height: 48 }

  it('moves with its window', () => {
    const perch = { id: 1, ledgeX: 100 }
    expect(followLedge(perch, 250, [{ id: 1, x: 150, y: 420, width: 600 }], pet)).toEqual({ x: 300, y: 372, perch: { id: 1, ledgeX: 150 } })
  })

  it('stays on an edge that got shorter', () => {
    const perch = { id: 1, ledgeX: 100 }
    expect(followLedge(perch, 600, [{ id: 1, x: 100, y: 300, width: 300 }], pet)?.x).toBe(336)
  })

  it('falls when its window closes, shrinks away or is covered', () => {
    expect(followLedge({ id: 1, ledgeX: 100 }, 200, [{ id: 2, x: 100, y: 300, width: 600 }], pet)).toBeNull()
  })
})
