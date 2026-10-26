/**
 * Changes list — rows come from ``git-diff/files`` (complete however big the
 * diff), and a row's diff body is fetched for that file alone, only while
 * it is expanded. The list used to be parsed out of one whole-repo diff cut
 * at 512 K characters, which dropped every file past the cut and re-sent
 * the whole diff after each agent write.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, within } from '@testing-library/react'
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

async function renderList(changes: WorkspaceChangesResponse, expanded: string[] = []) {
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
          openChangedFile={() => {}}
          openDiffTab={() => {}}
          setMobileFileActions={() => {}}
          setDesktopFileActions={() => {}}
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

  it('says how many files a capped list leaves out', async () => {
    await renderList(changesOf(['a.ts', 'b.ts', 'c.ts'], 12_345))

    expect(screen.getByText('Showing 3 of 12,345 changed files.')).toBeTruthy()
  })

  it('renders 200 rows at a time', async () => {
    const user = userEvent.setup()
    await renderList(changesOf(Array.from({ length: 450 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`)))

    expect(rows()).toHaveLength(200)
    await user.click(screen.getByRole('button', { name: 'Show 200 more (250 not shown)' }))
    expect(rows()).toHaveLength(400)
    await user.click(screen.getByRole('button', { name: 'Show 50 more (50 not shown)' }))
    expect(rows()).toHaveLength(450)
    expect(screen.queryByRole('button', { name: /^Show \d+ more/ })).toBeNull()
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

    expect(await screen.findByText('This diff is too large to show in full.')).toBeTruthy()
    expect(screen.getByText('new line')).toBeTruthy()
  })
})
