/**
 * WorkspaceFilesPanel — mobile edge-swipe exclusion regression.
 *
 * On mobile, WorkspaceFilesPanel renders as a fixed bottom-sheet overlay
 * (backdrop + sliding panel) that isn't tracked by useEdgeSwipe's drawer
 * set. Without `data-swipe-ignore`, an edge-zone touch on top of it would
 * be read as a fresh "open" gesture for the sidebar/actions drawer
 * underneath, silently swapping the files panel for a drawer mid-use.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { render, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true }))
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { WorkspaceFilesPanel } from '@/components/WorkspaceFilesPanel'
import type { WorkspaceFileInfo } from '@/api/types'

afterEach(cleanup)

const SID = '01900000-0000-7000-8000-000000000001'

function stubFiles(files: WorkspaceFileInfo[]) {
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const url = String(args[0])
    if (url.includes('/api/session/') && url.includes('/files')) {
      return new Response(JSON.stringify({ files, truncated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

function renderPanel() {
  stubFiles([])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceFilesPanel open sessionId={SID} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('WorkspaceFilesPanel — mobile edge-swipe exclusion', () => {
  it('marks the mobile backdrop and sliding panel data-swipe-ignore', async () => {
    renderPanel()

    const panel = await new Promise<HTMLElement>((resolve) => {
      const check = () => {
        const el = document.querySelector('[aria-label="Workspace files"]')
        if (el) resolve(el as HTMLElement)
        else setTimeout(check, 5)
      }
      check()
    })
    expect(panel).toHaveAttribute('data-swipe-ignore')

    const backdrop = document.querySelector('[aria-hidden="true"]')
    expect(backdrop).not.toBeNull()
    expect(backdrop).toHaveAttribute('data-swipe-ignore')
  })
})
