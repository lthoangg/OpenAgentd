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
  compactMode,
  compactLabels,
  countLabel,
  goalLabel,
  islandHitBox,
  islandHeight,
  islandMode,
  islandWidth,
  listOrder,
  primarySessionId,
  rowSignature,
  serverSignature,
  serversWithoutLater,
  withoutLater,
  type IslandGoal,
  type IslandSession,
  type UnreachableServer,
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
const hover = { ...defaults, expandOnHover: true }
const lost: UnreachableServer = { id: 'http://nas:4082', name: 'NAS', reason: 'unreachable' }

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

  // The notch used to open a 400px panel over the menu bar on a stray hover.
  it('opens on a click by default, and hover is an option', () => {
    expect(defaults.expandOnHover).toBe(false)
    expect(islandMode([running('a')], [], true, defaults)).toBe('running')
    expect(islandMode([running('a')], [], false, defaults, true)).toBe('expanded')
    expect(islandMode([], [done('x')], false, defaults, true)).toBe('expanded')
  })

  it('expands on hover to list active and unread sessions when that is chosen', () => {
    expect(islandMode([running('a')], [], true, hover)).toBe('expanded')
    expect(islandMode([], [done('x')], true, hover)).toBe('expanded')
    expect(islandMode([running('a')], [], false, hover)).toBe('running')
  })

  it('has nothing to open while nothing is shown', () => {
    expect(islandMode([], [], true, hover, true)).toBe('hidden')
  })

  it('says a server cannot be reached when that is all there is', () => {
    expect(compactMode([], [], [lost])).toBe('offline')
    expect(compactMode([running('a')], [], [lost])).toBe('running')
    expect(islandMode([], [], false, defaults, true, [lost])).toBe('expanded')
  })
})

describe('compactLabels', () => {
  it('names a single session and counts several', () => {
    expect(compactLabels([running('a', 'Refactor auth')], [])).toEqual({ lead: '', detail: 'Refactor auth' })
    expect(compactLabels([running('a'), running('b')], [])).toEqual({ lead: '', detail: '2 sessions' })
  })

  it('counts only the waiting sessions while any wait', () => {
    expect(compactLabels([waiting('a', 'Plan review'), running('b')], [])).toEqual({ lead: 'Needs you', detail: 'Plan review' })
    expect(compactLabels([waiting('a'), waiting('b'), running('c')], [])).toEqual({ lead: 'Needs you', detail: '2 sessions' })
  })

  // One vocabulary on every surface (the sidebar, the pet, the tray).
  it('never says "Needs input", "Working" or "Finished"', () => {
    const words = [
      compactLabels([waiting('a')], []).lead,
      compactLabels([running('a')], []).lead,
      compactLabels([], [done('x')]).lead,
      compactLabels([], [failed('x')]).lead,
      compactLabels([], [], [lost]).lead,
    ]
    // Running work says no word at all.
    expect(words).toEqual(['Needs you', '', 'Done', 'Failed', "Can't reach"])
  })

  it('names the server that cannot be reached, or counts several', () => {
    expect(compactLabels([], [], [lost])).toEqual({ lead: "Can't reach", detail: 'NAS' })
    expect(compactLabels([], [], [lost, { ...lost, id: 'b', name: 'Lab' }])).toEqual({ lead: "Can't reach", detail: '2 servers' })
    expect(compactCount([], [], [lost, { ...lost, id: 'b' }])).toBe(2)
  })

  it('reports unread finishes, or failures', () => {
    expect(compactLabels([], [done('x', 'Fix tooltip slide')])).toEqual({ lead: 'Done', detail: 'Fix tooltip slide' })
    expect(compactLabels([], [failed('x')]).lead).toBe('Failed')
    expect(compactLabels([], [done('x'), failed('y')])).toEqual({ lead: 'Done', detail: '2 sessions' })
  })

  it('shows unread finishes over running work, and a waiting session over both', () => {
    expect(compactLabels([running('a', 'Docs')], [done('x', 'Fix tooltip slide')])).toEqual({ lead: 'Done', detail: 'Fix tooltip slide' })
    expect(compactLabels([running('a'), waiting('b', 'Plan review')], [done('x')])).toEqual({ lead: 'Needs you', detail: 'Plan review' })
  })

  it("shows a goal's progress while it runs, and what became of it once it ended", () => {
    const goal = withGoal(running('a', 'Migrate'), { status: 'active', turn: 7, maxTurns: 50 })
    expect(compactLabels([goal], [])).toEqual({ lead: 'Goal 7/50', detail: 'Migrate' })
    expect(compactLabels([goal, running('b')], [])).toEqual({ lead: '', detail: '2 sessions' })

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

  it('shrinks into the notch when hidden and grows two equal wings, one either side of it', () => {
    expect(islandWidth('hidden', notch)).toBe(188)
    expect(islandWidth('running', notch)).toBe(188 + 2 * WING_WIDTH)
    expect(islandWidth('done', notch)).toBe(188 + 2 * WING_WIDTH)
    expect(islandWidth('offline', notch)).toBe(188 + 2 * WING_WIDTH)
    // A symbol, or a number up to "99+", fits; a word does not have to.
    expect(WING_WIDTH).toBeGreaterThanOrEqual(32)
    expect(WING_WIDTH).toBeLessThanOrEqual(44)
  })

  // The compact pill used to hang left of the notch only, so it looked lopsided
  // and slid sideways as it opened.
  it('reports a hit area centred on the notch, with both corners, in every mode', () => {
    const width = islandWidth('running', notch)
    expect(islandHitBox(width)).toEqual({ width: 188 + 2 * WING_WIDTH + 2 * EAR_WIDTH, shift: 0 })
    expect(islandHitBox(400)).toEqual({ width: 400 + 2 * EAR_WIDTH, shift: 0 })
  })

  it('puts the same two wings side by side without a notch, and widens when expanded', () => {
    expect(islandWidth('hidden', plain)).toBe(PLAIN_HIDDEN_WIDTH)
    expect(islandWidth('running', plain)).toBe(PLAIN_WIDTH)
    expect(PLAIN_WIDTH).toBe(2 * WING_WIDTH)
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

  it('keeps the number inside its wing', () => {
    expect(countLabel(1)).toBe('1')
    expect(countLabel(99)).toBe('99')
    expect(countLabel(100)).toBe('99+')
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

describe('Later', () => {
  it('hides a row until something about it changes', () => {
    const later = new Map([['w', rowSignature({ ...waiting('w'), questionId: 'q1' })]])
    const rows = [{ ...waiting('w'), questionId: 'q1' }, done('x')]
    expect(withoutLater(rows, later).map((r) => r.id)).toEqual(['x'])
    // A new question on the same session is news.
    expect(withoutLater([{ ...waiting('w'), questionId: 'q2' }], later).map((r) => r.id)).toEqual(['w'])
    // So is the turn ending.
    expect(withoutLater([done('w')], later).map((r) => r.id)).toEqual(['w'])
  })

  it('brings back a new finish that looks like the one put off', () => {
    const first = { ...done('x'), finishedSeq: 1 }
    const later = new Map([['x', rowSignature(first)]])
    expect(withoutLater([first], later)).toEqual([])
    expect(withoutLater([{ ...done('x'), finishedSeq: 2 }], later).map((r) => r.id)).toEqual(['x'])
  })

  it('hides a server that cannot be reached until it recovers and drops again', () => {
    const later = new Map([[`server:${lost.id}`, serverSignature(lost)]])
    expect(serversWithoutLater([lost], later)).toEqual([])
    expect(serversWithoutLater([{ ...lost, reason: 'key_rejected' }], later)).toHaveLength(1)
    expect(serversWithoutLater([lost], new Map())).toEqual([lost])
  })
})
