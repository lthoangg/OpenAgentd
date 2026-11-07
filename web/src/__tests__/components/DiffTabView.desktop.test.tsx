/**
 * A desktop diff wraps by default, and the same Wrap toggle the phone has
 * keeps lines whole (scrolling sideways) when a wide diff reads better that way.
 * Side by side shows the old file beside the new one, and falls back to
 * unified while the panel is too narrow for two columns.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => false }))

import { DiffTabView } from '@/components/WorkspacePanel/DiffTabView'
import { queryKeys } from '@/queries/keys'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n')
// Context, two lines replaced by one, then context again.
const REPLACE = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,4 +1,3 @@', ' keep', '-gone one', '-gone two', '+came', ' tail'].join('\n')
const originalFetch = globalThis.fetch
const originalWidth = window.innerWidth
beforeEach(() => {
  useDisplayPrefsStore.setState({ diffLayout: 'unified' })
})
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
})

function renderDiff(diff: string) {
  globalThis.fetch = mock(async () => new Response(
    JSON.stringify(({ workspace: '/w', is_git_repo: true, diff })),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(queryKeys.coding.changes('/w'), { workspace: '/w', is_git_repo: true, files: [] })
  return render(<QueryClientProvider client={client}><DiffTabView workspace="/w" path="a.ts" /></QueryClientProvider>)
}

describe('DiffTabView on desktop', () => {
  it('starts wrapped and keeps lines whole from the Wrap toggle', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify(({ workspace: '/w', is_git_repo: true, diff: DIFF })),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.coding.changes('/w'), { workspace: '/w', is_git_repo: true, files: [] })
    const { container } = render(<QueryClientProvider client={client}><DiffTabView workspace="/w" path="a.ts" /></QueryClientProvider>)

    await screen.findByText('new')
    const diff = () => container.querySelector<HTMLElement>('[data-diff-wrap]')!
    expect(diff().dataset.diffWrap).toBe('on')
    const toggle = screen.getByRole('button', { name: 'Wrap lines' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(diff().dataset.diffWrap).toBe('off')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('lays the old file beside the new one from Side by side, and remembers the choice', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    const { container } = renderDiff(REPLACE)
    await screen.findByText('came')
    expect(container.querySelector('[data-diff-layout]')?.getAttribute('data-diff-layout')).toBe('unified')

    const toggle = screen.getByRole('button', { name: 'Side by side' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(useDisplayPrefsStore.getState().diffLayout).toBe('split')
    expect(container.querySelector('[data-diff-layout]')?.getAttribute('data-diff-layout')).toBe('split')

    // Each row pairs an old line with a new one; context sits on both sides.
    const rows = Array.from(container.querySelectorAll('[data-split-row]')).map((row) =>
      Array.from(row.querySelectorAll('[data-split-side]')).map((side) => `${side.getAttribute('data-split-side')}:${side.textContent}`))
    expect(rows).toEqual([
      ['ctx:1keep', 'ctx:1keep'],
      ['del:2gone one', 'add:2came'],
      ['del:3gone two', 'empty:'],
      ['ctx:4tail', 'ctx:3tail'],
    ])
    // Side by side wraps in its columns: no Wrap toggle.
    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull()
    expect(within(container).getByText('gone two')).toBeTruthy()
  })

  it('stays unified while the panel is too narrow for two columns', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 560 })
    useDisplayPrefsStore.setState({ diffLayout: 'split' })
    const { container } = renderDiff(REPLACE)
    await screen.findByText('came')

    expect(container.querySelector('[data-diff-layout]')?.getAttribute('data-diff-layout')).toBe('unified')
    const toggle = screen.getByRole('button', { name: 'Side by side' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-description')).toBe('Shown unified until the panel is wider')
    expect(screen.getByRole('button', { name: 'Wrap lines' })).toBeTruthy()
  })
})
