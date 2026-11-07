/**
 * Desktop's sidebar search (mockup 8.1): matches grouped under their
 * workspace with a count, a summary line, the matched text marked in each
 * title, and the arrow keys reaching the results from the field. The
 * phone's Sessions search keeps its flat list.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@tanstack/react-pacer', () => ({ useDebouncedValue: (value: unknown) => [value] }))
const MATCHES = [
  { id: '1', title: 'Fix flaky auth test', workspace: '/w/openagentd' },
  { id: '2', title: 'Magic-link AUTH', workspace: '/w/FitYourCV' },
  { id: '3', title: 'Rotate auth tokens', workspace: '/w/openagentd' },
]
mock.module('@/queries/useSessionsQuery', () => ({
  useSessionSearchQuery: (query: string) => ({
    data: query ? { pages: [{ data: MATCHES, has_more: false }] } : undefined,
    isFetching: false,
  }),
  useSessionsQuery: () => ({ data: { pages: [{ data: [], has_more: false }] } }),
}))

import { SessionSearch } from '@/components/Sidebar/SessionSearch'

afterEach(cleanup)

const workspaceName = (path: string) => path.split('/').at(-1) ?? path

function search(text: string, cancel = false) {
  render(<SessionSearch cancel={cancel} focusKey={0} workspaceName={workspaceName} onSessionSelect={() => {}} onClose={() => {}} />)
  const input = screen.getByRole('searchbox')
  fireEvent.change(input, { target: { value: text } })
  return { input, results: screen.getByRole('region', { name: 'Search results' }) }
}

describe('SessionSearch on desktop', () => {
  it('groups matches under their workspace, in order, with counts and a summary', () => {
    const { results } = search('auth')

    expect(within(results).getByText('3 results · 2 workspaces')).toBeTruthy()
    const groups = within(results).getAllByRole('list')
    expect(groups.map((list) => list.getAttribute('aria-label'))).toEqual(['openagentd, 2 sessions', 'FitYourCV, 1 session'])
    // Each title as read: the plain copy beside the marked one (ui/match-marks).
    expect(within(groups[0]).getAllByRole('button').map((row) => row.querySelector('[data-search-title] .sr-only')?.textContent))
      .toEqual(['Fix flaky auth test', 'Rotate auth tokens'])
  })

  it('marks the matched text in each title, whatever its case', () => {
    const { results } = search('auth')

    expect(Array.from(results.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['auth', 'auth', 'AUTH'])
  })

  it('moves from the field into the results with ↓, and back with ↑', () => {
    const { input, results } = search('auth')
    const rows = within(results).getAllByRole('button')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    // The sidebar walks the rows from there, as it walks the tree.
    expect(rows.every((row) => row.hasAttribute('data-sidebar-session'))).toBe(true)

    fireEvent.keyDown(rows[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)
  })

  it("keeps the phone's flat list, each row naming its workspace", () => {
    const { results } = search('auth', true)

    expect(within(results).queryByText('3 results · 2 workspaces')).toBeNull()
    expect(within(results).getAllByRole('list')).toHaveLength(1)
    expect(results.querySelector('mark')).toBeNull()
    expect(within(results).getAllByRole('button')[0].textContent).toBe('Fix flaky auth testopenagentd')
  })
})
