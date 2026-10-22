import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DEFAULT_ISLAND_SETTINGS, type IslandSession, type IslandSettings, type IslandStatus, type IslandView } from '@/island/status'
import { useFakeTimers } from '../fake-timers'

type Call = [string, Record<string, unknown> | undefined]
let calls: Call[] = []
let view: IslandView
const handlers = new Map<string, (event: { payload: unknown }) => void>()

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    if (cmd === 'island_state') return view
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

const done = (id: string, title: string): IslandSession =>
  ({ id, title, workspace: 'web', state: 'done', question: null })

function status(seq: number, sessions: IslandSession[], unread: IslandSession[] = []): IslandStatus {
  return { seq, sessions, unread }
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
const pill = () => document.querySelector('.island') as HTMLElement

async function mount(settings: Partial<IslandSettings> = {}) {
  view = { ...view, settings: { ...DEFAULT_ISLAND_SETTINGS, ...settings } }
  render(<Island />)
  await waitFor(() => expect(handlers.has('island-pointer')).toBe(true))
  await waitFor(() => expect(lastFit()).toBeDefined())
}

beforeEach(() => {
  calls = []
  handlers.clear()
  view = { status: status(1, []), geometry: { hasNotch: true, width: 188, height: 38 }, settings: DEFAULT_ISLAND_SETTINGS }
})
afterEach(cleanup)

describe('Island', () => {
  it('asks to stay hidden while nothing is active', async () => {
    await mount()
    expect(lastFit()).toMatchObject({ visible: false })
  })

  it('shows a running session, then grows out of the notch', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth')]))
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText('Refactor auth')).toBeInTheDocument()
    // The canvas comes up with the pill still notch-sized…
    expect(lastFit()).toMatchObject({ visible: true, width: 188 + 16 })
    // …then the pill opens to its full width.
    await waitFor(() => expect(pill().dataset.open).toBe('true'))
    expect(lastFit()).toMatchObject({ visible: true, width: 188 + 200 + 16 })
  })

  it('puts a waiting session first and shows its question when the pointer is over it', async () => {
    await mount()
    push(status(2, [waiting('w', 'Plan review', 'Keep the old token format?'), running('a', 'Docs')]))
    expect(screen.getByText('Needs input')).toBeInTheDocument()
    expect(screen.queryByText('Keep the old token format?')).toBeNull()

    point(true)
    expect(screen.getByRole('list', { name: 'Sessions' })).toBeInTheDocument()
    expect(screen.getByText('Keep the old token format?')).toBeInTheDocument()
    point(false)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('does not expand on hover when that is turned off', async () => {
    await mount({ expandOnHover: false })
    push(status(2, [running('a', 'Refactor auth')]))
    point(true)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('opens the clicked session', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth'), running('b', 'Docs')]))
    point(true)
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }))
    fireEvent.click(screen.getByRole('button', { name: /Working/ }))
    await waitFor(() => expect(opened()).toEqual(['b', 'a']))
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

  it('lists unread sessions after the active ones, to open or dismiss', async () => {
    await mount()
    push(status(2, [running('a', 'Docs')], [done('d', 'Fix tooltip slide')]))
    point(true)
    const rows = within(screen.getByRole('list', { name: 'Sessions' })).getAllByRole('listitem').map((li) => li.textContent)
    expect(rows).toEqual(['Docsweb', 'Fix tooltip slideweb'])

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Fix tooltip slide' }))
    await waitFor(() => expect(dismissed()).toEqual(['d']))
    expect(opened()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /^Fix tooltip slide/ }))
    await waitFor(() => expect(opened()).toEqual(['d']))
  })

  it('applies changed settings at once', async () => {
    await mount()
    push(status(2, [running('a', 'Refactor auth')]))
    emit('island-settings-changed', { ...DEFAULT_ISLAND_SETTINGS, expandOnHover: false })
    point(true)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('ignores a snapshot older than the one it has', async () => {
    await mount()
    push(status(5, [running('a', 'Newer')]))
    push(status(4, []))
    expect(screen.getByText('Newer')).toBeInTheDocument()
  })
})
