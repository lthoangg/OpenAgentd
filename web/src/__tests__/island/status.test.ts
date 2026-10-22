import { describe, expect, it } from 'bun:test'
import {
  CANVAS_HEIGHT,
  DEFAULT_ISLAND_SETTINGS,
  EXPANDED_WIDTH,
  IDLE_PLAIN_WIDTH,
  IDLE_WING_WIDTH,
  PLAIN_WIDTH,
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
const done = { id: 'x', title: 'Fix tooltip slide', failed: false }
const defaults = DEFAULT_ISLAND_SETTINGS

describe('islandMode', () => {
  it('is hidden with nothing active and nothing just finished', () => {
    expect(islandMode([], null, false, defaults)).toBe('hidden')
    expect(islandMode([], null, true, defaults)).toBe('hidden')
  })

  it('lets a waiting session take priority over running ones', () => {
    expect(islandMode([running('a')], null, false, defaults)).toBe('running')
    expect(islandMode([running('a'), waiting('b')], null, false, defaults)).toBe('needs_input')
  })

  it('expands on hover only when there are sessions to list', () => {
    expect(islandMode([running('a')], null, true, defaults)).toBe('expanded')
    expect(islandMode([], done, true, defaults)).toBe('done')
  })

  it('drops a pending finish as soon as something is active again', () => {
    expect(islandMode([running('a')], done, false, defaults)).toBe('running')
  })

  it('follows the settings for hover, finishes and idle', () => {
    expect(islandMode([running('a')], null, true, { ...defaults, expandOnHover: false })).toBe('running')
    expect(islandMode([], done, false, { ...defaults, showFinished: false })).toBe('hidden')
    expect(islandMode([], null, false, { ...defaults, showWhenIdle: true })).toBe('idle')
  })
})

describe('compactLabels', () => {
  it('names a single session and counts several', () => {
    expect(compactLabels([running('a', 'Refactor auth')], null)).toEqual({ lead: 'Working', detail: 'Refactor auth' })
    expect(compactLabels([running('a'), running('b')], null)).toEqual({ lead: 'Working', detail: '2 sessions' })
  })

  it('counts only the waiting sessions while any wait', () => {
    expect(compactLabels([waiting('a', 'Plan review'), running('b')], null)).toEqual({ lead: 'Needs input', detail: 'Plan review' })
    expect(compactLabels([waiting('a'), waiting('b'), running('c')], null)).toEqual({ lead: 'Needs input', detail: '2 sessions' })
  })

  it('reports a finish, or a failure', () => {
    expect(compactLabels([], done)).toEqual({ lead: 'Done', detail: 'Fix tooltip slide' })
    expect(compactLabels([], { ...done, failed: true }).lead).toBe('Failed')
  })
})

describe('islandWidth and islandHeight', () => {
  const notch = { hasNotch: true, width: 188, height: 38 }
  const plain = { hasNotch: false, width: 200, height: 24 }

  it('shrinks into the notch when hidden and grows a wing either side', () => {
    expect(islandWidth('hidden', notch)).toBe(188)
    expect(islandWidth('idle', notch)).toBe(188 + 2 * IDLE_WING_WIDTH)
    expect(islandWidth('running', notch)).toBe(188 + 2 * WING_WIDTH)
  })

  it('uses fixed pills without a notch, and widens when expanded', () => {
    expect(islandWidth('idle', plain)).toBe(IDLE_PLAIN_WIDTH)
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
  it('opens the first listed session, else the one that just finished', () => {
    expect(primarySessionId([waiting('w'), running('r')], null)).toBe('w')
    expect(primarySessionId([], done)).toBe('x')
    expect(primarySessionId([], null)).toBeNull()
  })
})
