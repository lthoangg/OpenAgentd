import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  DEFAULT_ISLAND_SETTINGS,
  EAR_WIDTH,
  WING_WIDTH,
  type IslandSession,
  type IslandSettings,
  type IslandStatus,
  type IslandView,
  type UnreachableServer,
} from '@/island/status'
import { useFakeTimers } from '../fake-timers'

type Call = [string, Record<string, unknown> | undefined]
let calls: Call[] = []
let view: IslandView
let closeMenu: (() => void) | undefined
/** What `island_answer` does next: take the answer, or refuse it. */
let answerResult: 'ok' | 'fail' = 'ok'
const handlers = new Map<string, (event: { payload: unknown }) => void>()

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    if (cmd === 'island_state') return view
    if (cmd === 'island_context_menu') return new Promise<void>((resolve) => { closeMenu = resolve })
    if (cmd === 'island_answer') {
      if (answerResult === 'fail') throw new Error('The server refused the answer')
      return 'answered'
    }
    return undefined
  },
}))

mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
}))

const { Island } = await import('@/island/Island')

const running = (id: string, title: string): IslandSession =>
  ({ id, title, workspace: 'web', state: 'running', question: null })
const waiting = (id: string, title: string, question: string): IslandSession =>
  ({ id, title, workspace: 'api', state: 'needs_input', question })
const asking = (id: string, title: string, question: string, choices: string[], questionId = `q-${id}`): IslandSession =>
  ({ ...waiting(id, title, question), questionId, choices })

const done = (id: string, title: string): IslandSession =>
  ({ id, title, workspace: 'web', state: 'done', question: null })

const lost: UnreachableServer = { id: 'http://nas:4082', name: 'NAS', reason: 'unreachable' }

function status(seq: number, sessions: IslandSession[], unread: IslandSession[] = [], unreachable: UnreachableServer[] = []): IslandStatus {
  return { seq, sessions, unread, unreachable }
}

function emit(event: string, payload: unknown) {
  act(() => handlers.get(event)?.({ payload }))
}
const push = (next: IslandStatus) => emit('island-status', next)
const point = (inside: boolean) => emit('island-pointer', { inside, x: 10, y: 10 })

const fits = () => calls.filter(([cmd]) => cmd === 'island_fit').map(([, args]) => args)
const lastFit = () => fits().at(-1)
const opened = () => calls.filter(([cmd]) => cmd === 'island_open_session').map(([, args]) => args?.sessionId)
const dismissed = () => calls.filter(([cmd]) => cmd === 'island_dismiss').map(([, args]) => args?.sessionId)
const answers = () => calls.filter(([cmd]) => cmd === 'island_answer').map(([, args]) => args)
const pill = () => document.querySelector('.island') as HTMLElement
const list = () => screen.getByRole('list', { name: 'Sessions' })
/** The title of each row of the open list, in order. */
const rowTitles = () => within(list()).getAllByRole('listitem').map((li) => li.querySelector('.island-row-title')?.textContent)
/** Open the list the way a click does. */
const openList = () => fireEvent.click(screen.getByRole('button', { name: /Show the list/ }))

async function mount(settings: Partial<IslandSettings> = {}) {
  view = { ...view, settings: { ...DEFAULT_ISLAND_SETTINGS, ...settings } }
  render(<Island />)
  await waitFor(() => expect(handlers.has('island-pointer')).toBe(true))
  await waitFor(() => expect(lastFit()).toBeDefined())
}

beforeEach(() => {
  calls = []
  closeMenu = undefined
  answerResult = 'ok'
  handlers.clear()
  view = { status: status(1, []), geometry: { hasNotch: true, width: 188, height: 38 }, settings: DEFAULT_ISLAND_SETTINGS }
})
afterEach(cleanup)

describe('Island', () => {
  it('asks to stay hidden while nothing is active', async () => {
    await mount()
    expect(lastFit()).toMatchObject({ visible: false })
  })

  it('shows a running session without a word, then grows out of the notch to the left only', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth')]))
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByText('Refactor auth')).toBeInTheDocument()
    // The canvas comes up with the pill still notch-sized…
    expect(lastFit()).toMatchObject({ visible: true, width: 188 + 16, shift: 0 })
    // …then the pill grows one wing left of the notch, wide enough for the
    // word; its right edge stays on the notch's, clear of the status icons.
    await waitFor(() => expect(pill().dataset.open).toBe('true'))
    expect(lastFit()).toMatchObject({ visible: true, width: 188 + WING_WIDTH + EAR_WIDTH, shift: -WING_WIDTH / 2 - EAR_WIDTH / 2 })
    expect(pill().style.getPropertyValue('--pill-shift')).toBe(`${-WING_WIDTH / 2}px`)
  })

  // The state was a colour and a mark; the word is what makes it readable.
  it('says each state in a word, in one vocabulary', async () => {
    await mount()
    push(status(2, [waiting('w', 'Plan review', 'Ship it?')]))
    expect(screen.getByText('Needs you')).toBeInTheDocument()
    push(status(3, [running('a', 'Docs')]))
    expect(screen.queryByText('Running')).toBeNull()
    push(status(4, [], [{ ...done('d', 'Docs'), state: 'failed' }]))
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText(/Needs input|Working|Finished/)).toBeNull()
  })

  it('counts several sessions beside the mark, and centres when expanded', async () => {
    await mount({ expandOnHover: true })
    push(status(2, [running('a', 'Refactor auth'), running('b', 'Docs')]))
    await waitFor(() => expect(pill().dataset.open).toBe('true'))
    expect(document.querySelector('.island-count')?.textContent).toBe('2')

    point(true)
    expect(lastFit()).toMatchObject({ width: 400 + 16, shift: 0 })
    expect(pill().style.getPropertyValue('--pill-shift')).toBe('0px')
  })

  it('shows no count for a single session', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth')]))
    await waitFor(() => expect(pill().dataset.open).toBe('true'))
    expect(document.querySelector('.island-count')).toBeNull()
  })

  it('opens on a click, not on hover, by default: the panel never lands on the menu bar by chance', async () => {
    await mount()
    push(status(2, [waiting('w', 'Plan review', 'Keep the old token format?'), running('a', 'Docs')]))
    expect(screen.getByText('Needs you')).toBeInTheDocument()
    point(true)
    expect(screen.queryByRole('list')).toBeNull()
    expect(lastFit()).not.toMatchObject({ width: 400 + 16 })

    openList()
    expect(list()).toBeInTheDocument()
    expect(screen.getByText('Keep the old token format?')).toBeInTheDocument()
    expect(opened()).toEqual([])
    expect(screen.getByRole('button', { name: /Close the list/ })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: /Close the list/ }))
    expect(screen.queryByRole('list')).toBeNull()
    expect(opened()).toEqual([])
  })

  it('closes a list a click opened once the pointer has been away a while', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth')]))
    const timers = useFakeTimers()
    try {
      point(true)
      openList()
      expect(list()).toBeInTheDocument()
      act(() => timers.tick(10_000))
      expect(list()).toBeInTheDocument()

      point(false)
      act(() => timers.tick(1_000))
      expect(list()).toBeInTheDocument()
      act(() => timers.tick(2_000))
      expect(screen.queryByRole('list')).toBeNull()
    } finally {
      timers.restore()
    }
  })

  it('expands on hover instead when that is chosen, and a click on the pill then opens its session', async () => {
    await mount({ expandOnHover: true })
    push(status(2, [waiting('w', 'Plan review', 'Keep the old token format?'), running('a', 'Docs')]))
    expect(screen.queryByText('Keep the old token format?')).toBeNull()

    point(true)
    expect(list()).toBeInTheDocument()
    expect(screen.getByText('Keep the old token format?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Needs you: Plan review/ }))
    await waitFor(() => expect(opened()).toEqual(['w']))
    point(false)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('applies changed settings at once', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth')]))
    point(true)
    expect(screen.queryByRole('list')).toBeNull()
    emit('island-settings-changed', { ...DEFAULT_ISLAND_SETTINGS, expandOnHover: true })
    expect(list()).toBeInTheDocument()
  })

  it('opens the clicked session', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth'), running('b', 'Docs')]))
    openList()
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }))
    await waitFor(() => expect(opened()).toEqual(['b']))
  })

  it('right-clicks a row without opening it and keeps the list up until the menu closes', async () => {
    await mount({ expandOnHover: true })
    push(status(2, [running('a', 'Refactor auth'), running('b', 'Docs')]))
    point(true)
    expect(fireEvent.contextMenu(screen.getByRole('button', { name: /Docs/ }), { clientX: 120, clientY: 80 })).toBe(false)
    await waitFor(() => expect(calls).toContainEqual(['island_context_menu', { sessionId: 'b', x: 120, y: 80 }]))
    expect(opened()).toEqual([])
    expect(dismissed()).toEqual([])
    point(false)
    expect(list()).toBeInTheDocument()
    await act(async () => closeMenu?.())
    expect(screen.queryByRole('list')).toBeNull()
    expect(opened()).toEqual([])
    expect(dismissed()).toEqual([])
  })

  it('uses the same priority for right-clicking the pill as for opening it', async () => {
    await mount()
    push(status(2, [running('a', 'Docs')], [done('d', 'Fix tooltip')]))
    const bar = screen.getByRole('button', { name: /Done:/ })
    fireEvent.contextMenu(bar, { clientX: 200, clientY: 20 })
    await waitFor(() => expect(calls).toContainEqual(['island_context_menu', { sessionId: 'd', x: 200, y: 20 }]))
    expect(opened()).toEqual([])
    await act(async () => closeMenu?.())

    push(status(3, [waiting('w', 'Review', 'Ship it?'), running('a', 'Docs')], [done('d', 'Fix tooltip')]))
    fireEvent.contextMenu(screen.getByRole('button', { name: /Needs you:/ }), { clientX: 210, clientY: 22 })
    await waitFor(() => expect(calls).toContainEqual(['island_context_menu', { sessionId: 'w', x: 210, y: 22 }]))
    await act(async () => closeMenu?.())
  })

  it('does not request a session menu while the pill has nothing to show', async () => {
    await mount()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'No active sessions' }))
    expect(calls.filter(([cmd]) => cmd === 'island_context_menu')).toEqual([])
  })

  it('suppresses the WebKit menu on canvas padding without requesting a session action', async () => {
    await mount()
    expect(fireEvent.contextMenu(document.querySelector('.island-canvas')!)).toBe(false)
    expect(calls.filter(([cmd]) => cmd === 'island_context_menu')).toEqual([])
  })

  it('holds the displayed snapshot during a menu and applies updates after cancellation', async () => {
    await mount({ expandOnHover: true })
    push(status(2, [running('a', 'Docs')]))
    point(true)
    fireEvent.contextMenu(within(list()).getByRole('button', { name: /^Docs/ }), { clientX: 100, clientY: 60 })
    push(status(3, []))
    point(false)
    expect(list()).toBeInTheDocument()
    expect(within(list()).getByRole('button', { name: /^Docs/ })).toBeInTheDocument()
    await act(async () => closeMenu?.())
    expect(screen.queryByRole('list')).toBeNull()
    expect(pill().dataset.open).toBe('false')
    expect(opened()).toEqual([])
    expect(dismissed()).toEqual([])
  })

  it('keeps a finished session up until it is read, then shrinks away', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth')]))
    const timers = useFakeTimers()
    try {
      push(status(3, [], [done('a', 'Refactor auth')]))
      expect(screen.getByText('Done')).toBeInTheDocument()
      act(() => timers.tick(60_000))
      expect(lastFit()).toMatchObject({ visible: true })

      push(status(4, [], []))
      // Shrinking back in: still up, and still showing what it showed.
      expect(pill().dataset.open).toBe('false')
      expect(lastFit()).toMatchObject({ visible: true })
      expect(screen.getByText('Done')).toBeInTheDocument()

      act(() => timers.tick(400))
      expect(lastFit()).toMatchObject({ visible: false })
    } finally {
      timers.restore()
    }
  })

  it('lists what needs you, then unread sessions, then running ones, with a word on each finished or waiting row', async () => {
    await mount()
    push(status(2, [running('a', 'Docs'), waiting('w', 'Plan', 'Ship it?')], [done('d', 'Fix tooltip slide')]))
    openList()
    expect(rowTitles()).toEqual(['Plan', 'Fix tooltip slide', 'Docs'])
    const chips = within(list()).getAllByRole('listitem').map((li) => li.querySelector('.island-chip')?.textContent)
    expect(chips).toEqual(['Needs you', 'Done', undefined])
    expect(within(list()).queryByText('Running')).toBeNull()
  })

  // × used to read the session away: a question lost with it.
  it('puts a row off with a 28px "Later" button that never reads or answers it', async () => {
    await mount()
    push(status(2, [running('a', 'Docs')], [done('d', 'Fix tooltip slide')]))
    openList()
    const later = screen.getByRole('button', { name: 'Later: Fix tooltip slide' })
    expect(later).toHaveAttribute('data-tip', 'Later')
    expect(later).not.toHaveAttribute('title')
    fireEvent.click(later)
    expect(rowTitles()).toEqual(['Docs'])
    expect(dismissed()).toEqual([])
    expect(opened()).toEqual([])
    expect(calls.some(([cmd]) => cmd === 'session_read')).toBe(false)

    // Something new about that session (it runs again, then finishes) brings it back.
    push(status(3, [running('d', 'Fix tooltip slide'), running('a', 'Docs')]))
    push(status(4, [running('a', 'Docs')], [done('d', 'Fix tooltip slide')]))
    expect(rowTitles()).toContain('Fix tooltip slide')
  })

  it('lets a question that was put off come back when the agent asks again', async () => {
    await mount()
    push(status(2, [asking('w', 'Plan', 'Which branch?', ['main', 'dev'], 'q1')]))
    openList()
    fireEvent.click(screen.getByRole('button', { name: 'Later: Plan' }))
    // Nothing is left to show: the pill goes, the question still waits on the server.
    expect(screen.queryByRole('list')).toBeNull()
    expect(pill().dataset.mode).toBe('hidden')

    push(status(3, [asking('w', 'Plan', 'Which branch?', ['main', 'dev'], 'q1')]))
    expect(pill().dataset.mode).toBe('hidden')
    push(status(4, [asking('w', 'Plan', 'And the tag?', ['v1', 'v2'], 'q2')]))
    expect(pill().dataset.mode).toBe('needs_input')
  })

  it('answers a question from its row and shows the session running at once', async () => {
    await mount()
    push(status(2, [asking('w', 'Pin credentials', 'What should this session do?', ['Wait for Work', 'Use Auto'])]))
    openList()
    expect(screen.getByRole('button', { name: 'Open to answer' })).toBeInTheDocument()
    const choice = screen.getByRole('button', { name: 'Use Auto' })
    expect(choice).toBeInTheDocument()

    fireEvent.click(choice)
    await waitFor(() => expect(answers()).toEqual([{ sessionId: 'w', questionId: 'q-w', answers: [['Use Auto']] }]))
    await waitFor(() => expect(within(list()).queryByText('Needs you')).toBeNull())
    expect(within(list()).getByRole('listitem').querySelector('.island-spinner')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Use Auto' })).toBeNull()
    expect(opened()).toEqual([])
  })

  it('tells you when an answer could not be sent, and keeps the buttons', async () => {
    answerResult = 'fail'
    const consoleError = console.error
    console.error = () => {}
    try {
      await mount()
      push(status(2, [asking('w', 'Pin credentials', 'What now?', ['Wait', 'Auto'])]))
      openList()
      fireEvent.click(screen.getByRole('button', { name: 'Wait' }))
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't send")
      expect(screen.getByRole('button', { name: 'Wait' })).toBeEnabled()
      expect(within(list()).getByText('Needs you')).toBeInTheDocument()
    } finally {
      console.error = consoleError
    }
  })

  it('sends a question that needs typing, or that has too many options, to the app', async () => {
    await mount()
    push(status(2, [
      waiting('t', 'Name it', 'What should it be called?'),
      asking('m', 'Pick one', 'Which?', ['a', 'b', 'c', 'd', 'e']),
    ]))
    openList()
    const rows = within(list()).getAllByRole('listitem')
    for (const row of rows) {
      expect(within(row).getAllByRole('button').map((b) => b.textContent)).toContain('Open to answer')
      expect(within(row).queryByRole('button', { name: 'a' })).toBeNull()
    }
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Open to answer' }))
    await waitFor(() => expect(opened()).toEqual(['t']))
    expect(answers()).toEqual([])
  })

  it("shows a goal's turn while it works, and its outcome once its last turn ends", async () => {
    await mount()
    push(status(2, [{ ...running('a', 'Migrate'), goal: { status: 'active', turn: 7, maxTurns: 50 } }]))
    expect(screen.getByText('Goal 7/50')).toBeInTheDocument()

    push(status(3, [], [{ ...done('a', 'Migrate'), goal: { status: 'achieved' } }]))
    expect(screen.getByText('Goal achieved')).toBeInTheDocument()
    expect(pill().querySelector('.island-mark--goal')).not.toBeNull()

    openList()
    const row = within(list()).getByRole('button', { name: /^Done Migrate/ })
    expect(row.querySelector('.island-row-meta')?.textContent).toBe('Goal achieved')
  })

  it('ignores a snapshot older than the one it has', async () => {
    await mount()
    push(status(5, [running('a', 'Newer')]))
    push(status(4, []))
    openList()
    expect(rowTitles()).toEqual(['Newer'])
  })

  it('names the server of each row when sessions come from more than one', async () => {
    await mount()
    push(status(2, [
      { ...waiting('w', 'Plan review', 'Ship it?'), server: 'Built-in server' },
      { ...running('r', 'Deploy'), server: 'LAN server' },
    ], [{ ...done('d', 'Migrate'), server: 'LAN server' }]))
    openList()
    const metas = within(list()).getAllByRole('listitem').map((li) => li.querySelector('.island-row-meta')?.textContent)
    expect(metas).toEqual(['Built-in server · api', 'LAN server · web', 'LAN server · web'])
  })

  it('leaves the server out when there is only one', async () => {
    await mount()
    push(status(2, [{ ...running('a', 'Docs'), server: null }]))
    openList()
    expect(within(list()).getByRole('listitem').querySelector('.island-row-meta')?.textContent).toBe('web')
  })

  // A server that dropped off used to take its rows with it, in silence.
  it("says a server can't be reached, with Retry, and lets you put that off", async () => {
    await mount()
    push(status(2, [running('a', 'Docs')], [], [lost]))
    openList()
    const row = within(list()).getByText('NAS').closest('li')!
    expect(within(row).getByText("Can't reach")).toBeInTheDocument()
    expect(within(row).getByText('Not answering')).toBeInTheDocument()

    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }))
    expect(calls.some(([cmd]) => cmd === 'island_retry')).toBe(true)

    fireEvent.click(within(row).getByRole('button', { name: 'Later: NAS' }))
    expect(rowTitles()).toEqual(['Docs'])
  })

  it("puts \"Can't reach\" on the pill when nothing else is active, and names a refused key", async () => {
    await mount()
    push(status(2, [], [], [{ ...lost, reason: 'key_rejected' }]))
    expect(screen.getByText("Can't reach")).toBeInTheDocument()
    expect(lastFit()).toMatchObject({ visible: true })
    openList()
    expect(within(list()).getByText('Access key rejected')).toBeInTheDocument()
  })
})
