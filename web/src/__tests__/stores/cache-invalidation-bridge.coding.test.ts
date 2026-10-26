import { describe, it, expect } from 'bun:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { applyCacheInvalidations } from '@/stores/cache-invalidation-bridge'
import { queryKeys } from '@/queries'

const WS = '/tmp/proj'

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Records every invalidated key instead of refetching. */
function recordingClient() {
  const client = new QueryClient()
  const keys: string[] = []
  /* eslint-disable @typescript-eslint/no-explicit-any */
  client.invalidateQueries = ((args: any) => {
    keys.push(JSON.stringify(args.queryKey))
    return Promise.resolve()
  }) as any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { client, keys }
}

const key = (queryKey: readonly unknown[]) => JSON.stringify(queryKey)

/** A mounted per-file diff body that counts its fetches. */
function watchFileDiff(client: QueryClient, path: string) {
  const fetches = { count: 0 }
  const observer = new QueryObserver(client, {
    queryKey: queryKeys.coding.fileDiff(WS, path),
    queryFn: () => {
      fetches.count += 1
      return Promise.resolve({ workspace: WS, is_git_repo: true, diff: `diff --git a/${path} b/${path}` })
    },
  })
  const unsubscribe = observer.subscribe(() => {})
  return { fetches, unsubscribe }
}

describe('applyCacheInvalidations — working-tree diffs', () => {
  it('refreshes the changed-paths list and only the touched files’ bodies after a write', () => {
    const { client, keys } = recordingClient()

    applyCacheInvalidations(client, [{ kind: 'coding_workspace_paths', workspace: WS, paths: ['src/a.ts'] }])

    expect(keys).toContain(key(queryKeys.coding.changes(WS)))
    expect(keys).toContain(key(queryKeys.coding.files(WS)))
    expect(keys).toContain(key(queryKeys.coding.status(WS)))
    expect(keys).toContain(key(queryKeys.coding.fileDiff(WS, 'src/a.ts')))
    expect(keys).not.toContain(key(queryKeys.coding.diff(WS)))
  })

  it('refetches an open body for a touched path and leaves the others alone', async () => {
    const client = new QueryClient()
    const foo = watchFileDiff(client, 'foo')
    const bar = watchFileDiff(client, 'bar')
    await flushMicrotasks()
    expect([foo.fetches.count, bar.fetches.count]).toEqual([1, 1])

    applyCacheInvalidations(client, [{ kind: 'coding_workspace_paths', workspace: WS, paths: ['foo'] }])
    await flushMicrotasks()

    expect([foo.fetches.count, bar.fetches.count]).toEqual([2, 1])
    foo.unsubscribe()
    bar.unsubscribe()
  })

  it('refetches every open body when the touched paths are unknown', async () => {
    const client = new QueryClient()
    const foo = watchFileDiff(client, 'foo')
    const bar = watchFileDiff(client, 'bar')
    await flushMicrotasks()

    applyCacheInvalidations(client, [{ kind: 'coding_workspace', workspace: WS }])
    await flushMicrotasks()

    expect([foo.fetches.count, bar.fetches.count]).toEqual([2, 2])
    foo.unsubscribe()
    bar.unsubscribe()
  })

  it('invalidates each query key once per batch', () => {
    const { client, keys } = recordingClient()

    applyCacheInvalidations(client, [
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['a'] },
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['b', 'a'] },
      { kind: 'coding_workspace_paths', workspace: WS, paths: ['c'] },
      { kind: 'todos', sessionId: 's1' },
      { kind: 'todos', sessionId: 's1' },
    ])

    for (const queryKey of [
      queryKeys.coding.changes(WS),
      queryKeys.coding.files(WS),
      queryKeys.coding.status(WS),
      queryKeys.coding.fileDiff(WS, 'a'),
      queryKeys.todos('s1'),
    ]) {
      expect(keys.filter((k) => k === key(queryKey))).toHaveLength(1)
    }
    expect(keys).toContain(key(queryKeys.coding.fileDiff(WS, 'b')))
    expect(keys).toContain(key(queryKeys.coding.fileDiff(WS, 'c')))
  })
})
