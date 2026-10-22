import { describe, expect, it } from 'bun:test'
import {
  CANVAS_HEIGHT,
  DEFAULT_ISLAND_SETTINGS,
  EXPANDED_WIDTH,
  PLAIN_WIDTH,
  PLAIN_HIDDEN_WIDTH,
  WING_WIDTH,
  compactLabels,
  islandHeight,
  islandMode,
  islandWidth,
  primarySessionId,
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

  it('stays up as done while a finished session is unread', () => {
    expect(islandMode([], [done('x')], false, defaults)).toBe('done')
    expect(islandMode([running('a')], [done('x')], false, defaults)).toBe('running')
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

  it('shows active work over unread finishes', () => {
    expect(compactLabels([running('a', 'Docs')], [done('x')])).toEqual({ lead: 'Working', detail: 'Docs' })
  })
})

describe('islandWidth and islandHeight', () => {
  const notch = { hasNotch: true, width: 188, height: 38 }
  const plain = { hasNotch: false, width: 200, height: 24 }

  it('shrinks into the notch when hidden and grows a wing either side', () => {
    expect(islandWidth('hidden', notch)).toBe(188)
    expect(islandWidth('running', notch)).toBe(188 + 2 * WING_WIDTH)
    expect(islandWidth('done', notch)).toBe(188 + 2 * WING_WIDTH)
  })

  it('uses fixed pills without a notch, and widens when expanded', () => {
    expect(islandWidth('hidden', plain)).toBe(PLAIN_HIDDEN_WIDTH)
    expect(islandWidth('running', plain)).toBe(PLAIN_WIDTH)
    expect(islandWidth('expanded', plain)).toBe(EXPANDED_WIDTH)
  })

  it('adds the list to the height only when expanded, up to the canvas', () => {
    expect(islandHeight('running', notch, 120)).toBe(38)
    expect(islandHeight('expanded', notch, 120)).toBe(158)
    expect(islandHeight('expanded', notch, 5_000)).toBe(CANVAS_HEIGHT)
  })
})

describe('primarySessionId', () => {
  it('opens the first listed session, else the newest unread one', () => {
    expect(primarySessionId([waiting('w'), running('r')], [done('x')])).toBe('w')
    expect(primarySessionId([], [done('x'), done('y')])).toBe('x')
    expect(primarySessionId([], [])).toBeNull()
  })
})
