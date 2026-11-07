/**
 * A phone's diff does not wrap by default: long lines scroll sideways in
 * the diff, and a Wrap toggle in the file bar wraps them (mockup J7 7.2).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

import { DiffTabView } from '@/components/WorkspacePanel/DiffTabView'
import { queryKeys } from '@/queries/keys'

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n')
const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('DiffTabView on a phone', () => {
  it('starts unwrapped and wraps from the Wrap toggle', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify(({ workspace: '/w', is_git_repo: true, diff: DIFF })),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.coding.changes('/w'), { workspace: '/w', is_git_repo: true, files: [] })
    const { container } = render(<QueryClientProvider client={client}><DiffTabView workspace="/w" path="a.ts" /></QueryClientProvider>)

    await screen.findByText('new')
    const diff = () => container.querySelector<HTMLElement>('[data-diff-wrap]')!
    expect(diff().dataset.diffWrap).toBe('off')
    const toggle = screen.getByRole('button', { name: 'Wrap lines' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(diff().dataset.diffWrap).toBe('on')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })
})
