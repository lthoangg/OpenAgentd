/**
 * Review dock web preview tabs: opened by a keyed shell request or the tab
 * bar's New preview action, kept mounted across tab switches, and closing
 * their listener with the last tab that uses it.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import type { PreviewTabRequest } from '@/components/WorkspacePanel/dock-tabs'

const WORKSPACE = '/repo/project'
const ORIGIN = 'http://127.0.0.1:52011'

mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

type Interceptor = { beforeAsyncRequest?: (args: { request: Request }) => Promise<Response | void> }
const happyDOM = (window as unknown as { happyDOM?: { settings: { fetch: { interceptor: Interceptor | null } } } }).happyDOM
if (happyDOM) {
  happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request }) => (request.url.startsWith(ORIGIN) ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) : undefined),
  }
}

let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = []

beforeEach(() => {
  localStorage.clear()
  _resetTerminalStoreForTests()
  useGitPanelStore.setState({ workspaces: {} })
  requests = []
  globalThis.fetch = mock(async (input: unknown, raw?: unknown) => {
    const url = String(input)
    const init = raw as RequestInit | undefined
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.endsWith('/api/preview') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { url?: string; path?: string }
      const id = body.path ? 'files' : 'dev'
      const path = body.path ? `/${body.path}` : new URL(body.url ?? 'http://localhost:5173').pathname
      return new Response(JSON.stringify({ id, workspace: WORKSPACE, kind: body.path ? 'file' : 'url', target: 'http://localhost:5173', port: 52011, origin: ORIGIN, path, url: `${ORIGIN}${path}`, console_errors: 0 }))
    }
    if (url.includes('/api/preview/') && method === 'DELETE') return new Response(null, { status: 204 })
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, { workspace: WORKSPACE, is_git_repo: false, diff: '' })
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(JSON.stringify({}), { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

async function renderPanel(previewRequest: PreviewTabRequest | null = null) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (request: PreviewTabRequest | null) => (
    <QueryClientProvider client={queryClient}>
      <WorkspacePanel workspace={WORKSPACE} open centerWidth={1400} previewRequest={request} />
    </QueryClientProvider>
  )
  let rerender: (node: React.ReactElement) => void = () => {}
  await act(async () => {
    rerender = render(ui(previewRequest)).rerender
  })
  return { rerender: (request: PreviewTabRequest | null) => act(async () => rerender(ui(request))) }
}

const posts = () => requests.filter((r) => r.url.endsWith('/api/preview') && r.method === 'POST')

describe('Review dock preview tabs', () => {
  it('opens a preview tab for a shell request and navigates it for a later one', async () => {
    const { rerender } = await renderPanel({ target: { kind: 'url', url: 'http://localhost:5173/' }, key: 1 })
    const tab = await screen.findByRole('button', { name: 'Preview localhost:5173' })
    expect(tab.getAttribute('aria-current')).toBe('true')
    await waitFor(() => expect(document.querySelector('iframe')?.getAttribute('src')).toBe(`${ORIGIN}/`))

    await rerender({ target: { kind: 'url', url: 'http://localhost:5173/pricing' }, key: 2 })
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(screen.getAllByRole('button', { name: 'Preview localhost:5173' })).toHaveLength(1)
    await waitFor(() => expect(document.querySelector('iframe')?.getAttribute('src')).toBe(`${ORIGIN}/pricing`))
  })

  it('focuses an open tab without navigating it when asked to', async () => {
    const { rerender } = await renderPanel({ target: { kind: 'url', url: 'http://localhost:5173/' }, key: 1 })
    await waitFor(() => expect(posts()).toHaveLength(1))
    await rerender({ target: { kind: 'url', url: 'http://localhost:5173/pricing' }, key: 2, focusOnly: true })
    // Give a navigation the chance to happen: it must not.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posts()).toHaveLength(1)
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(`${ORIGIN}/`)
  })

  it('keeps the page mounted while another tab is active', async () => {
    const { rerender } = await renderPanel({ target: { kind: 'url', url: 'http://localhost:5173/' }, key: 1 })
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy())
    const frame = document.querySelector('iframe')
    await rerender({ target: { kind: 'file', path: 'a.html' }, key: 2 })
    await screen.findByRole('button', { name: 'Preview a.html' })
    expect(document.querySelector('iframe')).toBe(frame)
    expect(frame?.closest('.hidden')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Preview localhost:5173' }))
    expect(frame?.closest('.hidden')).toBeNull()
  })

  it('opens the last dev server from New preview and closes its listener with the tab', async () => {
    localStorage.setItem(`oa-preview-last-url:${WORKSPACE}`, 'http://localhost:3000/app')
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'New preview' }))
    await screen.findByRole('button', { name: 'Preview localhost:3000' })
    await waitFor(() => expect(posts()[0]?.body).toEqual({ workspace: WORKSPACE, url: 'http://localhost:3000/app' }))

    fireEvent.click(screen.getByRole('button', { name: 'Close Preview localhost:3000' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/preview/dev'))).toBe(true))
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('keeps a shared file listener open until its last tab closes', async () => {
    const { rerender } = await renderPanel({ target: { kind: 'file', path: 'a.html' }, key: 1 })
    await screen.findByRole('button', { name: 'Preview a.html' })
    await rerender({ target: { kind: 'file', path: 'b.html' }, key: 2 })
    await screen.findByRole('button', { name: 'Preview b.html' })
    await waitFor(() => expect(posts()).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Close Preview b.html' }))
    await act(async () => {})
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close Preview a.html' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/preview/files'))).toBe(true))
  })

  it('closes the tab when Cmd/Ctrl+W is pressed inside the page', async () => {
    await renderPanel({ target: { kind: 'url', url: 'http://localhost:5173/' }, key: 1 })
    await screen.findByRole('button', { name: 'Preview localhost:5173' })
    const frame = await waitFor(() => {
      const el = document.querySelector('iframe')
      if (!el?.getAttribute('src')) throw new Error('no preview frame yet')
      return el
    })
    // The page's inspector forwards the key press it swallowed.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { ns: 'openagentd-preview', v: 1, type: 'shortcut', name: 'close-tab' },
        origin: ORIGIN,
        source: frame.contentWindow,
      }))
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview localhost:5173' })).toBeNull())
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/preview/dev'))).toBe(true))
  })
})
