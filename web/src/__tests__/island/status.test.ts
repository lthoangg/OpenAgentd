import { describe, expect, it } from 'bun:test'
import {
  CANVAS_HEIGHT,
  DEFAULT_ISLAND_SETTINGS,
  EXPANDED_WIDTH,
  PLAIN_WIDTH,
  PLAIN_HIDDEN_WIDTH,
  WING_WIDTH,
  EAR_WIDTH,
  compactCount,
  compactLabels,
  goalLabel,
  islandHitBox,
  islandHeight,
  islandMode,
  islandShift,
  islandWidth,
  listOrder,
  primarySessionId,
  type IslandGoal,
  type IslandSession,
} from '@/island/status'

const running = (id: string, title = `Task ${id}`): IslandSession =>
  ({ id, title, workspace: 'web', state: 'running', question: null })
const waiting = (id: string, title = `Ask ${id}`): IslandSession =>
  ({ id, title, workspace: 'web', state: 'needs_input', question: 'Which branch?' })
const done = (id: string, title = `Done ${id}`): IslandSession =>
  ({ id, title, workspace: 'web', state: 'done', question: null })
const failed = (id: string, title = `Failed ${id}`): IslandSession =>
  ({ id, title, workspace: 'web', state: 'failed', question: null })
const withGoal = (session: IslandSession, goal: IslandGoal): IslandSession => ({ ...session, goal })
const defaults = DEFAULT_ISLAND_SETTINGS

describe('islandMode', () => {
  it('is hidden with nothing active and nothing unread', () => {
    expect(islandMode([], [], false, defaults)).toBe('hidden')
    expect(islandMode([], [], true, defaults)).toBe('hidden')
  })

  it('lets a waiting session take priority over running ones', () => {
    expect(islandMode([running('a')], [], false, defaults)).toBe('running')
    expect(islandMode([running('a'), waiting('b')], [], false, defaults)).toBe('needs_input')
  })

  it('stays up as done while a finished session is unread, even over running work', () => {
    expect(islandMode([], [done('x')], false, defaults)).toBe('done')
    expect(islandMode([running('a')], [done('x')], false, defaults)).toBe('done')
    expect(islandMode([running('a'), waiting('b')], [done('x')], false, defaults)).toBe('needs_input')
  })

  it('expands on hover to list active and unread sessions', () => {
    expect(islandMode([running('a')], [], true, defaults)).toBe('expanded')
    expect(islandMode([], [done('x')], true, defaults)).toBe('expanded')
  })

  it('does not expand on hover when that is turned off', () => {
    expect(islandMode([running('a')], [], true, { ...defaults, expandOnHover: false })).toBe('running')
  })
})

describe('compactLabels', () => {
  it('names a single session and counts several', () => {
    expect(compactLabels([running('a', 'Refactor auth')], [])).toEqual({ lead: 'Working', detail: 'Refactor auth' })
    expect(compactLabels([running('a'), running('b')], [])).toEqual({ lead: 'Working', detail: '2 sessions' })
  })

  it('counts only the waiting sessions while any wait', () => {
    expect(compactLabels([waiting('a', 'Plan review'), running('b')], [])).toEqual({ lead: 'Needs input', detail: 'Plan review' })
    expect(compactLabels([waiting('a'), waiting('b'), running('c')], [])).toEqual({ lead: 'Needs input', detail: '2 sessions' })
  })

  it('reports unread finishes, or failures', () => {
    expect(compactLabels([], [done('x', 'Fix tooltip slide')])).toEqual({ lead: 'Done', detail: 'Fix tooltip slide' })
    expect(compactLabels([], [failed('x')]).lead).toBe('Failed')
    expect(compactLabels([], [done('x'), failed('y')])).toEqual({ lead: 'Done', detail: '2 sessions' })
  })

  it('shows unread finishes over running work, and a waiting session over both', () => {
    expect(compactLabels([running('a', 'Docs')], [done('x', 'Fix tooltip slide')])).toEqual({ lead: 'Done', detail: 'Fix tooltip slide' })
    expect(compactLabels([running('a'), waiting('b', 'Plan review')], [done('x')])).toEqual({ lead: 'Needs input', detail: 'Plan review' })
  })

  it("shows a goal's progress while it runs, and what became of it once it ended", () => {
    const goal = withGoal(running('a', 'Migrate'), { status: 'active', turn: 7, maxTurns: 50 })
    expect(compactLabels([goal], [])).toEqual({ lead: 'Goal 7/50', detail: 'Migrate' })
    expect(compactLabels([goal, running('b')], [])).toEqual({ lead: 'Working', detail: '2 sessions' })

    expect(compactLabels([], [withGoal(done('x', 'Migrate'), { status: 'achieved' })])).toEqual({ lead: 'Goal achieved', detail: 'Migrate' })
    expect(compactLabels([], [withGoal(done('x'), { status: 'paused' })]).lead).toBe('Goal paused')
    expect(compactLabels([], [withGoal(done('x'), { status: 'blocked' })]).lead).toBe('Goal blocked')
    expect(compactLabels([], [withGoal(done('x'), { status: 'achieved' }), done('y')]).lead).toBe('Done')
  })
})

describe('goalLabel', () => {
  it('names the goal, matching the notification, and nothing without one', () => {
    expect(goalLabel(withGoal(running('a'), { status: 'active', turn: 3, maxTurns: 10 }))).toBe('Goal 3/10')
    expect(goalLabel(withGoal(done('a'), { status: 'achieved' }))).toBe('Goal achieved')
    expect(goalLabel(running('a'))).toBeNull()
    expect(goalLabel({ ...running('a'), goal: null })).toBeNull()
  })
})

describe('islandWidth and islandHeight', () => {
  const notch = { hasNotch: true, width: 188, height: 38 }
  const plain = { hasNotch: false, width: 200, height: 24 }

  it('shrinks into the notch when hidden and grows one narrow wing, left of it', () => {
    expect(islandWidth('hidden', notch)).toBe(188)
    expect(islandWidth('running', notch)).toBe(188 + WING_WIDTH)
    expect(islandWidth('done', notch)).toBe(188 + WING_WIDTH)
    // Narrow enough to stay clear of the frontmost app's menus.
    expect(WING_WIDTH).toBeLessThanOrEqual(48)
  })

  it('keeps the right of the notch clear while compact, and centres when expanded', () => {
    // The pill's right edge sits on the notch's: nothing covers the status icons.
    expect(islandShift('running', notch)).toBe(-WING_WIDTH / 2)
    expect(islandShift('needs_input', notch)).toBe(-WING_WIDTH / 2)
    expect(islandShift('expanded', notch)).toBe(0)
    expect(islandShift('hidden', notch)).toBe(0)
    expect(islandShift('running', plain)).toBe(0)
  })

  it('reports a hit area that leaves out the hidden right corner while compact', () => {
    const width = islandWidth('running', notch)
    const box = islandHitBox('running', notch, width)
    const notchCentre = 0
    // Right edge of the hit area: exactly the notch's right edge.
    expect(notchCentre + box.shift + box.width / 2).toBe(188 / 2)
    expect(box.width).toBe(188 + WING_WIDTH + EAR_WIDTH)
    expect(islandHitBox('expanded', notch, 400)).toEqual({ width: 400 + 2 * EAR_WIDTH, shift: 0 })
  })

  it('uses small fixed pills without a notch, and widens when expanded', () => {
    expect(islandWidth('hidden', plain)).toBe(PLAIN_HIDDEN_WIDTH)
    expect(islandWidth('running', plain)).toBe(PLAIN_WIDTH)
    expect(PLAIN_WIDTH).toBeLessThanOrEqual(64)
    expect(islandWidth('expanded', plain)).toBe(EXPANDED_WIDTH)
    expect(islandWidth('expanded', notch)).toBe(EXPANDED_WIDTH)
  })

  it('adds the list to the height only when expanded, up to the canvas', () => {
    expect(islandHeight('running', notch, 120)).toBe(38)
    expect(islandHeight('expanded', notch, 120)).toBe(158)
    expect(islandHeight('expanded', notch, 5_000)).toBe(CANVAS_HEIGHT)
  })
})

describe('compactCount', () => {
  it('counts the sessions the compact pill stands for', () => {
    expect(compactCount([running('a')], [])).toBe(1)
    expect(compactCount([running('a'), running('b')], [])).toBe(2)
    expect(compactCount([running('a'), waiting('b')], [done('x'), done('y')])).toBe(1)
    expect(compactCount([running('a')], [done('x'), done('y')])).toBe(2)
  })
})

describe('primarySessionId', () => {
  it('opens a waiting session, else the newest unread one, else a running one', () => {
    expect(primarySessionId([waiting('w'), running('r')], [done('x')])).toBe('w')
    expect(primarySessionId([running('r'), waiting('w')], [done('x')])).toBe('w')
    expect(primarySessionId([running('r')], [done('x')])).toBe('x')
    expect(primarySessionId([running('r')], [])).toBe('r')
    expect(primarySessionId([], [done('x'), done('y')])).toBe('x')
    expect(primarySessionId([], [])).toBeNull()
  })
})

describe('listOrder', () => {
  it('lists waiting sessions, then unread finishes, then running work', () => {
    const order = listOrder([running('r'), waiting('w')], [done('x'), failed('y')]).map((s) => s.id)
    expect(order).toEqual(['w', 'x', 'y', 'r'])
  })
})
