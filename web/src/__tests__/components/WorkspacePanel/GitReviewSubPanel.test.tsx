/**
 * Changes list — rows come from ``git-diff/files`` (complete however big the
 * diff), and a row's diff body is fetched for that file alone, only while
 * it is expanded. The list used to be parsed out of one whole-repo diff cut
 * at 512 K characters, which dropped every file past the cut and re-sent
 * the whole diff after each agent write.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WorkspaceChangesResponse } from '@/api/types'
import { GitReviewSubPanel } from '@/components/WorkspacePanel/GitReviewSubPanel'
import { changedFilesFromResponse } from '@/components/WorkspacePanel/diff-helpers'

const WORKSPACE = '/repo/project'

let requestedUrls: string[] = []
let bodyTruncated = false

beforeEach(() => {
  requestedUrls = []
  bodyTruncated = false
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    requestedUrls.push(url)
    const [path] = new URL(url, 'http://localhost').searchParams.getAll('paths')
    const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old line\n+new line`
    return new Response(JSON.stringify({ workspace: WORKSPACE, is_git_repo: true, diff, untracked: [], truncated: bodyTruncated }))
  }) as typeof fetch
})
afterEach(cleanup)

function changesOf(paths: string[], total = paths.length): WorkspaceChangesResponse {
  return {
    workspace: WORKSPACE,
    is_git_repo: true,
    files: paths.map((path) => ({ path, status: 'M', additions: 1, deletions: 1 })),
    total,
    truncated: total > paths.length,
  }
}

type PanelProps = Partial<React.ComponentProps<typeof GitReviewSubPanel>>

async function renderList(changes: WorkspaceChangesResponse, expanded: string[] = [], overrides: PanelProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <GitReviewSubPanel
          workspace={WORKSPACE}
          changedFiles={changedFilesFromResponse(changes)}
          changes={{ isLoading: false, isError: false, data: changes }}
          files={{ isLoading: false, data: { files: [] } }}
          selectedFilePath={null}
          expandedDiffs={new Set(expanded)}
          toggleDiffExpanded={() => {}}
          setMobileFileActions={() => {}}
          setDesktopFileActions={() => {}}
          {...overrides}
        />
      </QueryClientProvider>,
    )
  })
}

const rows = () => within(screen.getByRole('list', { name: 'Changed files' })).getAllByRole('listitem')
const bodyRequests = () => requestedUrls.filter((url) => url.includes('/workspace/git-diff/view'))

describe('Changes list', () => {
  it('lists every changed file with no truncation warning', async () => {
    await renderList(changesOf(['a.ts', 'b.ts', 'c.ts']))

    expect(rows()).toHaveLength(3)
    expect(screen.queryByText(/incomplete|Showing/)).toBeNull()
  })

  // Rulebook 10: loading is a skeleton, not a line of text.
  it('shows skeleton rows named "Loading diff" under a row while its diff loads', async () => {
    globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    await renderList(changesOf(['a.ts']), ['a.ts'])

    const loading = screen.getByRole('status', { name: 'Loading diff' })
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText('Loading diff…')).toBeNull()
  })

  it('shows file rows named "Loading changed files" while the list loads', async () => {
    await renderList(changesOf([]), [], { changes: { isLoading: true, isError: false } })

    const loading = screen.getByRole('status', { name: 'Loading changed files' })
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(4)
    expect(screen.queryByText('Loading changed files…')).toBeNull()
  })

  it('shows the same rows while the file listing loads', async () => {
    await renderList(changesOf([]), [], { files: { isLoading: true } })
    expect(screen.getByRole('status', { name: 'Loading changed files' })).toBeTruthy()
  })

  it('leads each row with the file name, its folder after it', async () => {
    // A path cut at the end ("web/src/__tests__/components/In…") hid the
    // one part that tells files apart.
    await renderList(changesOf(['web/src/components/InputComposer.tsx', 'README.md']))

    const row = screen.getByRole('button', { name: 'Expand diff for web/src/components/InputComposer.tsx' })
    const name = within(row).getByText('InputComposer.tsx')
    const folder = within(row).getByText('web/src/components')
    expect(name.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(folder.className).toContain('text-(--color-text-muted)')
    expect(within(screen.getByRole('button', { name: 'Expand diff for README.md' })).getByText('README.md')).toBeTruthy()
  })

  it('says how many files a capped list leaves out', async () => {
    await renderList(changesOf(['a.ts', 'b.ts', 'c.ts'], 12_345))

    expect(screen.getByText('Showing 3 of 12,345 changed files.')).toBeTruthy()
  })

  it('renders 200 rows at a time', async () => {
    await renderList(changesOf(Array.from({ length: 450 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`)))
    // Hundreds of rows make role queries slow, so this counts list items directly.
    const list = screen.getByRole('list', { name: 'Changed files' })
    const count = () => list.querySelectorAll(':scope > li').length

    expect(count()).toBe(200)
    act(() => { fireEvent.click(screen.getByText('Show 200 more (250 not shown)')) })
    expect(count()).toBe(400)
    act(() => { fireEvent.click(screen.getByText('Show 50 more (50 not shown)')) })
    expect(count()).toBe(450)
    expect(screen.queryByText(/^Show \d+ more/)).toBeNull()
  })

  it('loads no diff body for a collapsed row', async () => {
    await renderList(changesOf(['a.ts', 'b.ts']))

    expect(bodyRequests()).toHaveLength(0)
  })

  it('fetches an expanded row’s diff for that file alone', async () => {
    await renderList(changesOf(['a.ts', 'b.ts']), ['b.ts'])

    expect(await screen.findByText('new line')).toBeTruthy()
    expect(bodyRequests()).toHaveLength(1)
    expect(new URL(bodyRequests()[0], 'http://localhost').searchParams.getAll('paths')).toEqual(['b.ts'])
  })

  it('flags a single file’s diff that was cut at the server’s cap', async () => {
    bodyTruncated = true
    await renderList(changesOf(['a.ts']), ['a.ts'])

    const notice = await screen.findByText('This diff is too large to show in full.')
    // Dark orange on the warning wash, not the 2:1 solid warning hue.
    expect(notice.className).toContain('text-(--accent-orange-text)')
    expect(notice.className).toContain('bg-(--color-warning-subtle)')
    expect(notice.className).not.toContain('text-(--color-warning)')
    expect(screen.getByText('new line')).toBeTruthy()
  })
})

describe('Changes list rows', () => {
  // A click on a file used to open a separate diff tab; the diff now opens
  // right under the row, and "Open diff in tab" lives in the row's menu.
  it('shows the diff in place from a click on the row, and says whether it is open', async () => {
    const user = userEvent.setup()
    const toggleDiffExpanded = mock((_path: unknown) => {})
    await renderList(changesOf(['a.ts', 'b.ts']), ['a.ts'], { toggleDiffExpanded })

    const open = screen.getByRole('button', { name: 'Collapse diff for a.ts' })
    expect(open.getAttribute('aria-expanded')).toBe('true')
    const closed = screen.getByRole('button', { name: 'Expand diff for b.ts' })
    expect(closed.getAttribute('aria-expanded')).toBe('false')
    await user.click(closed)

    expect(toggleDiffExpanded).toHaveBeenCalledWith('b.ts')
    expect(screen.queryByRole('button', { name: /Open diff tab/ })).toBeNull()
  })

  it('has one control for the diff: the row itself, no separate chevron button', async () => {
    await renderList(changesOf(['a.ts']))

    const row = within(rows()[0]).getAllByRole('button')
    expect(row.map((b) => b.getAttribute('aria-label'))).toEqual(['Expand diff for a.ts', 'More actions for a.ts'])
  })

  it('has no hover- or focus-only controls: ⋯ is always there, and the old reveals are gone', async () => {
    await renderList(changesOf(['a.ts']))

    const more = screen.getByRole('button', { name: 'More actions for a.ts' })
    expect(more.className).toContain('size-6')
    expect(more.className).toContain('pointer-coarse:size-9')
    expect(more.closest('[class*="hidden"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open a.ts' })).toBeNull()
    expect(screen.queryByTitle('Open diff in tab')).toBeNull()
    expect(screen.queryByTitle('Open file')).toBeNull()
    // The counts stay put: nothing swaps them out on hover.
    const row = screen.getByRole('button', { name: 'Expand diff for a.ts' })
    expect(row.innerHTML).not.toContain('group-hover')
  })

  it('opens the file’s actions menu from ⋯ under the button on desktop', async () => {
    const user = userEvent.setup()
    const setDesktopFileActions = mock((_value: unknown) => {})
    const setMobileFileActions = mock((_value: unknown) => {})
    await renderList(changesOf(['a.ts']), [], { setDesktopFileActions, setMobileFileActions })

    await user.click(screen.getByRole('button', { name: 'More actions for a.ts' }))

    expect(setMobileFileActions).not.toHaveBeenCalled()
    expect(setDesktopFileActions).toHaveBeenCalledTimes(1)
    expect(setDesktopFileActions.mock.calls[0][0]).toMatchObject({ file: { path: 'a.ts' }, x: expect.any(Number), y: expect.any(Number) })
  })

  it('opens the same actions as a sheet from ⋯ on a phone', async () => {
    const user = userEvent.setup()
    const setDesktopFileActions = mock((_value: unknown) => {})
    const setMobileFileActions = mock((_value: unknown) => {})
    await renderList(changesOf(['a.ts']), [], { mobile: true, setDesktopFileActions, setMobileFileActions })

    await user.click(screen.getByRole('button', { name: 'More actions for a.ts' }))

    expect(setDesktopFileActions).not.toHaveBeenCalled()
    expect(setMobileFileActions.mock.calls[0][0]).toMatchObject({ path: 'a.ts' })
  })
})

describe('Changes list footer', () => {
  it('has no commit button and no totals bar under the list', async () => {
    await renderList(changesOf(['a.ts', 'b.ts']))

    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull()
    expect(screen.queryByText('2 files · +2 · −2')).toBeNull()
    // The list is the last thing in the view.
    expect(screen.getByRole('list', { name: 'Changed files' }).nextElementSibling).toBeNull()
  })

  it('says "No changes" once when nothing is changed', async () => {
    await renderList(changesOf([]))

    expect(screen.getAllByText('No changes')).toHaveLength(1)
    expect(screen.queryByText('No changed files')).toBeNull()
    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull()
  })
})

describe('Changes load errors', () => {
  it('names the failure and offers Retry, which reloads the list', async () => {
    const user = userEvent.setup()
    const refetch = mock(async () => {})
    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <GitReviewSubPanel
          workspace={WORKSPACE}
          changedFiles={[]}
          changes={{ isLoading: false, isError: true, refetch }}
          files={{ isLoading: false, data: { files: [] } }}
          selectedFilePath={null}
          expandedDiffs={new Set()}
          toggleDiffExpanded={() => {}}
          setMobileFileActions={() => {}}
          setDesktopFileActions={() => {}}
        />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('alert').textContent).toBe("Couldn't load changed files.")
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('disables Retry while the retry runs', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GitReviewSubPanel
          workspace={WORKSPACE}
          changedFiles={[]}
          changes={{ isLoading: false, isError: true, isFetching: true, refetch: async () => {} }}
          files={{ isLoading: false, data: { files: [] } }}
          selectedFilePath={null}
          expandedDiffs={new Set()}
          toggleDiffExpanded={() => {}}
          setMobileFileActions={() => {}}
          setDesktopFileActions={() => {}}
        />
      </QueryClientProvider>,
    )

    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
