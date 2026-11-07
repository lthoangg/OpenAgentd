import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
// The 200ms debounce is not under test here: settle each keystroke at once.
mock.module('@tanstack/react-pacer', () => ({ useDebouncedValue: (value: unknown) => [value] }))
mock.module('@/queries/useSessionsQuery', () => ({
  useSessionSearchQuery: (query: string) => ({
    data: query ? { pages: [{ data: [], has_more: false }] } : undefined,
    isFetching: false,
  }),
  useSessionsQuery: () => ({
    data: {
      pages: [{
        data: [
          { id: 'a', title: 'Fix login', workspace: '/repo' },
          { id: 'b', title: 'Loose chat', workspace: null },
          { id: 'c', title: 'Ship docs', workspace: '/repo' },
        ],
        has_more: false,
      }],
    },
  }),
}))

import { SessionSearch } from '@/components/Sidebar/SessionSearch'

afterEach(cleanup)

function renderSearch(onClose = () => {}) {
  render(
    <SessionSearch focusKey={0} workspaceName={(path) => path} onSessionSelect={() => {}} onClose={onClose} />,
  )
  return screen.getByRole('searchbox')
}

describe('SessionSearch — no matches', () => {
  it('echoes the query and offers Clear search', () => {
    const input = renderSearch()
    fireEvent.change(input, { target: { value: 'migration' } })

    const results = screen.getByRole('region', { name: 'Search results' })
    // An empty state at row scale: straight quotes, no trailing period.
    const title = within(results).getByText('No sessions match "migration"')
    expect(title.closest('[data-empty-state="compact"]')).toBeTruthy()

    fireEvent.click(within(results).getByRole('button', { name: 'Clear search' }))
    expect((input as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(within(results).queryByText(/No sessions match/)).toBeNull()
  })

  it('still closes the search on Escape', () => {
    const onClose = mock(() => {})
    const input = renderSearch(onClose)
    fireEvent.change(input, { target: { value: 'migration' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('SessionSearch — before typing', () => {
  it('lists recently opened sessions on the phone (with Cancel), not an empty pane', () => {
    const onSelect = mock(() => {})
    render(<SessionSearch cancel focusKey={0} workspaceName={(path) => path} onSessionSelect={onSelect} onClose={() => {}} />)

    const recent = screen.getByRole('list', { name: 'Recently opened' })
    expect(within(recent).getAllByRole('button').map((row) => row.textContent)).toEqual(['Fix login/repo', 'Ship docs/repo'])
    fireEvent.click(within(recent).getByText('Ship docs'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), '/repo', expect.anything())
  })

  it('hides the recent list once there is a query, and on desktop', () => {
    render(<SessionSearch cancel focusKey={0} workspaceName={(path) => path} onSessionSelect={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'x' } })
    expect(screen.queryByRole('list', { name: 'Recently opened' })).toBeNull()
    cleanup()
    renderSearch()
    expect(screen.queryByRole('list', { name: 'Recently opened' })).toBeNull()
  })
})
