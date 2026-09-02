import { describe, it, expect, mock, beforeEach } from 'bun:test'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetDiff = mock(() =>
  Promise.resolve({
    workspace: '/tmp/proj',
    is_git_repo: true,
    diff: '',
    untracked: [],
    truncated: false,
  }),
) as any
;(mock as any).module('@/api/client', () => ({
  getCodingWorkspaceGitDiff: mockGetDiff,
  postAgentChat: mock(() => Promise.resolve()) as any,
  postAgentCommand: mock(() => Promise.resolve()) as any,
  agentStream: mock(() => {}) as any,
  agentStatus: mock(() => Promise.resolve(null)) as any,
  sessionHistory: mock(() =>
    Promise.resolve({ lead: { messages: [] }, members: [], has_more: false, next_cursor: null }),
  ) as any,
  listCodingWorkspaceFiles: mock(() => Promise.resolve({ files: [], truncated: false })) as any,
  getCodingWorkspaceStatus: mock(() => Promise.resolve(null)) as any,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { applyCacheInvalidations, mergeScopedDiff } from '@/stores/cache-invalidation-bridge'
import { queryKeys } from '@/queries'
import { QueryClient } from '@tanstack/react-query'
import type { WorkspaceGitDiffResponse } from '@/api/types'

const WS = '/tmp/proj'

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  mockGetDiff.mockReset()
  mockGetDiff.mockImplementation(() =>
    Promise.resolve({
      workspace: WS,
      is_git_repo: true,
      diff: '',
      untracked: [],
      truncated: false,
    }),
  )
})

describe('mergeScopedDiff', () => {
  const headerA = 'diff --git a/foo b/foo\nindex 1..2 100644\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-a\n+b'
  const headerB = '\ndiff --git a/bar b/bar\nindex 3..4 100644\n--- a/bar\n+++ b/bar\n@@ -1 +1 @@\n-x\n+y'
  const headerC = '\ndiff --git a/baz b/baz\nindex 5..6 100644\n--- a/baz\n+++ b/baz\n@@ -1 +1 @@\n-m\n+n'

  it('returns the scoped diff verbatim when the existing diff is empty', () => {
    expect(mergeScopedDiff('', 'diff --git a/x b/x\n+new', ['x'])).toBe('diff --git a/x b/x\n+new')
  })

  it('drops the matching per-file section and appends the scoped replacement', () => {
    const existing = headerA + headerB
    const scoped = 'diff --git a/foo b/foo\n+++ updated'
    const out = mergeScopedDiff(existing, scoped, ['foo'])
    expect(out).not.toContain('-a\n+b')
    expect(out).toContain('diff --git a/bar b/bar')
    expect(out).toContain('+++ updated')
  })

  it('keeps untouched per-file sections in place', () => {
    const existing = headerA + headerB + headerC
    const out = mergeScopedDiff(existing, 'diff --git a/bar b/bar\n+new bar', ['bar'])
    expect(out).toContain('-a\n+b')
    expect(out).toContain('-m\n+n')
    expect(out).not.toContain('-x\n+y')
    expect(out).toContain('+new bar')
  })

  it('appends scoped sections for paths absent from the existing diff (new file)', () => {
    const existing = headerA
    const scoped = 'diff --git a/new.ts b/new.ts\nnew file mode 100644\n+content'
    const out = mergeScopedDiff(existing, scoped, ['new.ts'])
    expect(out).toContain('diff --git a/foo b/foo')
    expect(out).toContain('diff --git a/new.ts b/new.ts')
  })

  it('drops sections without re-appending when scoped diff is empty (path reverted to clean)', () => {
    const existing = headerA + headerB
    const out = mergeScopedDiff(existing, '', ['foo'])
    expect(out).not.toContain('diff --git a/foo b/foo')
    expect(out).toContain('diff --git a/bar b/bar')
  })
})

describe('applyCacheInvalidations — coding_workspace_paths', () => {
  it('invalidates files + status (cheap full refresh) but NOT diff', async () => {
    const client = new QueryClient()
    const calls: { queryKey: readonly unknown[] }[] = []
    /* eslint-disable @typescript-eslint/no-explicit-any */
    client.invalidateQueries = ((args: any) => {
      calls.push(args)
      return Promise.resolve()
    }) as any
    /* eslint-enable @typescript-eslint/no-explicit-any */

    applyCacheInvalidations(client, [
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['src/a.ts'] },
    ])
    await flushMicrotasks()

    const keys = calls.map((c) => c.queryKey)
    expect(keys).toContainEqual(queryKeys.coding.files(WS))
    expect(keys).toContainEqual(queryKeys.coding.status(WS))
    expect(keys).not.toContainEqual(queryKeys.coding.diff(WS))
  })

  it('patches the cached diff via setQueryData when cache is populated', async () => {
    const client = new QueryClient()
    const cached: WorkspaceGitDiffResponse = {
      workspace: WS,
      is_git_repo: true,
      diff:
        'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+keep\n' +
        '\ndiff --git a/bar b/bar\n@@ -1 +1 @@\n-x\n+y',
      untracked: [],
      truncated: false,
    }
    client.setQueryData(queryKeys.coding.diff(WS), cached)

    mockGetDiff.mockImplementation(() =>
      Promise.resolve({
        workspace: WS,
        is_git_repo: true,
        diff: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+NEW',
        untracked: [],
        truncated: false,
      }),
    )

    applyCacheInvalidations(client, [
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['foo'] },
    ])
    await flushMicrotasks()

    expect(mockGetDiff).toHaveBeenCalledWith(WS, ['foo'])
    const after = client.getQueryData<WorkspaceGitDiffResponse>(queryKeys.coding.diff(WS))!
    expect(after.diff).toContain('+NEW')
    expect(after.diff).not.toContain('+keep')
    expect(after.diff).toContain('+y')
  })

  it('is a no-op on the diff cache when there is no cached entry', async () => {
    const client = new QueryClient()
    applyCacheInvalidations(client, [
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['foo'] },
    ])
    await flushMicrotasks()

    expect(mockGetDiff).not.toHaveBeenCalled()
    expect(client.getQueryData(queryKeys.coding.diff(WS))).toBeUndefined()
  })

  it('falls back to a full diff invalidation when the scoped fetch fails', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.coding.diff(WS), {
      workspace: WS,
      is_git_repo: true,
      diff: 'diff --git a/foo b/foo\n+x',
      untracked: [],
      truncated: false,
    } satisfies WorkspaceGitDiffResponse)

    const calls: { queryKey: readonly unknown[] }[] = []
    /* eslint-disable @typescript-eslint/no-explicit-any */
    client.invalidateQueries = ((args: any) => {
      calls.push(args)
      return Promise.resolve()
    }) as any
    /* eslint-enable @typescript-eslint/no-explicit-any */

    mockGetDiff.mockImplementation(() => Promise.reject(new Error('boom')))

    applyCacheInvalidations(client, [
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['foo'] },
    ])
    await flushMicrotasks()

    const keys = calls.map((c) => c.queryKey)
    expect(keys).toContainEqual(queryKeys.coding.diff(WS))
  })

  it('is a no-op on the diff cache when is_git_repo is false', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.coding.diff(WS), {
      workspace: WS,
      is_git_repo: false,
      diff: '',
      untracked: [],
      truncated: false,
    } satisfies WorkspaceGitDiffResponse)

    applyCacheInvalidations(client, [
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['foo'] },
    ])
    await flushMicrotasks()

    expect(mockGetDiff).not.toHaveBeenCalled()
  })
})
