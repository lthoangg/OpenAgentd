/**
 * The palette on an empty query starts with what was run last (desktop
 * mockup 9.1), and a search marks the query's words in each row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { CommandPalette, type Command, type PaletteSessions } from '@/components/CommandPalette'
import { PALETTE_RECENTS_KEY } from '@/lib/palette-recents'

const COMMANDS: Command[] = [
  { id: 'new-chat', label: 'New Chat', group: 'Session', action: () => {} },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', group: 'View', action: () => {} },
  { id: 'agent-info', label: 'Agent Info', group: 'View', action: () => {} },
]
const SESSIONS: PaletteSessions = {
  items: [{ id: 's1', title: 'Fix flaky auth test', description: 'openagentd · 2h', activityAt: null, open: () => {} }],
  loading: false,
  onSearch: () => {},
}

beforeEach(() => localStorage.removeItem(PALETTE_RECENTS_KEY))
afterEach(cleanup)

const open = () => render(<CommandPalette commands={COMMANDS} sessions={SESSIONS} onClose={() => {}} />)
const recent = () => screen.queryByRole('group', { name: 'Recent' })

describe('CommandPalette — Recent', () => {
  it('has no Recent group before anything has run', () => {
    open()
    expect(recent()).toBeNull()
  })

  it('lists what ran last first under Recent, sessions included', () => {
    open()
    fireEvent.click(screen.getByText('Agent Info'))
    cleanup()
    open()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'flaky' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    cleanup()

    open()
    const rows = within(recent()!).getAllByRole('button')
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual(['Fix flaky auth test', 'Agent Info'])
    // Recent leads the list: the first row is the one Enter runs.
    expect(rows[0].getAttribute('data-idx')).toBe('0')
  })

  it('leaves Recent out while searching', () => {
    open()
    fireEvent.click(screen.getByText('Agent Info'))
    cleanup()
    open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tog' } })
    expect(recent()).toBeNull()
  })

  it('drops a recent command that no longer exists', () => {
    localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(['gone', 'new-chat']))
    open()
    expect(within(recent()!).getAllByRole('button').map((row) => row.querySelector('span')?.textContent)).toEqual(['New Chat'])
  })
})

describe('CommandPalette — match marks', () => {
  it("marks the query's words in each matching row", () => {
    open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tog side' } })

    const row = screen.getByRole('button', { name: /Toggle Sidebar/ })
    expect(Array.from(row.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['Tog', 'Side'])
  })
})
