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
    expect(within(results).getByText('No sessions match “migration”.')).toBeTruthy()

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
