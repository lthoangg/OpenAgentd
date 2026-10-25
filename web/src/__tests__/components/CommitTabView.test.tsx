/**
 * CommitTabView opens a commit's patches by default only while they stay
 * small, so a commit with a regenerated lockfile does not mount it.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { CommitTabView } from '@/components/WorkspacePanel/CommitTabView'
import { queryKeys } from '@/queries/keys'
import type { GitCommit } from '@/api/types'

afterEach(cleanup)

const commit = { sha: 'abc123', short_sha: 'abc123', subject: 'Update deps', author_name: 'Dev', timestamp: 1_700_000_000 } as GitCommit

function fileDiff(path: string, added: number): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,0 +1,${added} @@`, ...Array.from({ length: added }, (_, i) => `+line ${i}`)].join('\n')
}

function renderCommit(files: Array<[string, number]>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(queryKeys.coding.commitDiff('/w', commit.sha), { diff: files.map(([p, n]) => fileDiff(p, n)).join('\n') })
  render(<QueryClientProvider client={client}><CommitTabView workspace="/w" commit={commit} /></QueryClientProvider>)
}

const isOpen = (path: string) => screen.getByRole('button', { name: new RegExp(path.replace('.', '\\.')) }).getAttribute('aria-expanded') === 'true'

describe('CommitTabView — default expansion', () => {
  it('opens every patch of a small commit', () => {
    renderCommit([['a.ts', 5], ['b.ts', 8], ['c.ts', 3]])
    expect(['a.ts', 'b.ts', 'c.ts'].map(isOpen)).toEqual([true, true, true])
  })

  it('keeps a huge patch collapsed and still opens the small ones around it', () => {
    renderCommit([['a.ts', 5], ['bun.lock', 5000], ['z.ts', 5]])
    expect(['a.ts', 'bun.lock', 'z.ts'].map(isOpen)).toEqual([true, false, true])
    fireEvent.click(screen.getByRole('button', { name: /bun\.lock/ }))
    expect(isOpen('bun.lock')).toBe(true)
    expect(isOpen('a.ts')).toBe(true)
  })

  it('opens nothing by default for a commit touching more than 10 files', () => {
    renderCommit(Array.from({ length: 11 }, (_, i) => [`f${i}.ts`, 2] as [string, number]))
    expect(isOpen('f0.ts')).toBe(false)
  })
})

describe('CommitTabView — load failure', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('keeps the error text and retries the commit diff on Retry', async () => {
    let fail = true
    globalThis.fetch = mock(async () => (fail
      ? new Response('{"detail":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ sha: commit.sha, diff: fileDiff('a.ts', 2) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><CommitTabView workspace="/w" commit={commit} /></QueryClientProvider>)

    expect(await screen.findByText('Failed to load commit changes.')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.queryByText('Failed to load commit changes.')).toBeNull())
    expect(screen.getByRole('button', { name: /a\.ts/ })).toBeTruthy()
  })
})
