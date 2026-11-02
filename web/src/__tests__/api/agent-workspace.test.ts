import { afterEach, describe, expect, it } from 'bun:test'

import {
  getCodingWorkspaceCommitDiff,
  getCodingWorkspaceGitDiff,
  getCodingWorkspaceGitHistory,
  getCodingWorkspaceStatus,
  listCodingWorkspaceFiles,
  listSessions,
} from '@/api/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('workspace API reads', () => {
  it('forwards the query cancellation signal to every Git and workspace read', async () => {
    const signal = new AbortController().signal
    const signals: Array<AbortSignal | null | undefined> = []
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch

    await Promise.all([
      listCodingWorkspaceFiles('/workspace', signal),
      getCodingWorkspaceGitDiff('/workspace', undefined, signal),
      getCodingWorkspaceStatus('/workspace', signal),
      getCodingWorkspaceGitHistory('/workspace', 50, null, signal),
      getCodingWorkspaceCommitDiff('/workspace', 'abc123', signal),
    ])

    expect(signals).toEqual([signal, signal, signal, signal, signal])
  })
})

describe('listSessions', () => {
  it('repeats the workspaces param once per checkout path', async () => {
    const urls: string[] = []
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input))
      return Promise.resolve(new Response('{"data":[],"next_cursor":null,"has_more":false}', { status: 200 }))
    }) as typeof fetch

    await listSessions(null, 5, { workspaces: ['/repo/project', '/data/worktrees/a,b'] })

    const params = new URL(urls[0], 'http://x').searchParams
    expect(params.getAll('workspaces')).toEqual(['/repo/project', '/data/worktrees/a,b'])
    expect(params.has('workspace')).toBe(false)
  })
})
