import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cleanupSidebarHarness, fx, renderSidebarWithProps, resetSidebarHarness } from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  describe('Locate folder… on a workspace whose folder is gone', () => {
    function serve(missing: boolean, calls: Array<{ url: string; body: unknown }>) {
      globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
        const req = init as RequestInit | undefined
        const url = String(input)
        const body = req?.body ? JSON.parse(String(req.body)) : null
        calls.push({ url, body })
        if (url.includes('/api/agent/workspace/tree')) {
          return new Response(JSON.stringify({ repositories: [{ path: '/repo/agentd', name: 'agentd', missing, worktrees: [] }] }))
        }
        if (url.includes('/api/agent/workspace/browse')) {
          return new Response(JSON.stringify({ path: '/repo', parent: '/', directories: [{ name: 'openagentd', path: '/repo/openagentd' }] }))
        }
        if (url.includes('/api/agent/workspace/relocate')) {
          return new Response(JSON.stringify({
            from: '/repo/agentd',
            workspace: body.to,
            dry_run: body.dry_run,
            sessions: 42,
            scheduled_tasks: 3,
            worktrees: [{ path: '/wt/agentd-1/fix', managed: true }, { path: '/repo/agentd-spike', managed: false }],
            groups: ['backend', 'release'],
            merge: true,
            target_sessions: 2,
            moved_worktrees: [],
            warnings: [],
          }))
        }
        if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
        return new Response(JSON.stringify({ data: [], next_cursor: null, has_more: false }))
      }) as typeof fetch
    }

    it('offers Locate folder… only on a missing workspace', async () => {
      const user = userEvent.setup()
      fx.sessionsData = []
      fx.workspaceSessionsData = fx.sessionsData
      serve(false, [])
      await renderSidebarWithProps({ workspace: '/repo/agentd' })
      await user.click(await waitFor(() => screen.getByLabelText('Actions for agentd')))
      expect(screen.queryByRole('menuitem', { name: 'Locate folder…' })).toBeNull()
    })

    it('picks the new folder, shows what moves (and the merge), then moves it', async () => {
      const user = userEvent.setup()
      fx.isTauri = false
      fx.sessionsData = []
      fx.workspaceSessionsData = fx.sessionsData
      const calls: Array<{ url: string; body: unknown }> = []
      serve(true, calls)
      localStorage.setItem('oa-coding-workspaces', JSON.stringify([{ id: 'main', path: '/repo/agentd', createdAt: '2026-05-01T00:00:00Z' }]))
      localStorage.setItem('oa-last-coding-workspace', 'main')
      await renderSidebarWithProps({ workspace: '/repo/agentd' })

      await user.click(await waitFor(() => screen.getByLabelText('Actions for agentd')))
      await user.click(screen.getByRole('menuitem', { name: 'Locate folder…' }))
      // The server's folder browser opens in the old folder's parent.
      const dialog = (await screen.findByText('Locate “agentd”')).closest('[data-dialog-content]') as HTMLElement
      await waitFor(() => expect(calls.some((c) => c.url.includes('/workspace/browse?path=%2Frepo'))).toBe(true))
      await user.click(await within(dialog).findByRole('button', { name: 'openagentd' }))
      await user.click(within(dialog).getByRole('button', { name: 'Use this folder' }))

      // A dry run counts what moves; the merge is called out.
      const confirm = await screen.findByText('Move “agentd” to this folder?')
      const box = confirm.closest('[data-dialog-content]') as HTMLElement
      expect(calls.find((c) => c.url.includes('/relocate'))?.body).toEqual({ from: '/repo/agentd', to: '/repo', dry_run: true })
      expect(Array.from(box.querySelectorAll('[data-relocate-moves] li')).map((li) => li.textContent)).toEqual([
        '42 sessions',
        '2 worktrees (links repaired)',
        '3 scheduled tasks',
        'Groups: backend, release',
      ])
      expect(box.querySelector('[data-relocate-merge]')?.textContent).toBe('“repo” is already in the sidebar with 2 sessions. They are merged into one workspace.')

      await user.click(within(box).getByRole('button', { name: 'Move workspace' }))
      await waitFor(() => expect(screen.queryByText('Move “agentd” to this folder?')).toBeNull())
      expect(calls.filter((c) => c.url.includes('/relocate')).at(-1)?.body).toEqual({ from: '/repo/agentd', to: '/repo', dry_run: false })
      // The saved list and the last-opened pointer follow the folder.
      const saved = JSON.parse(localStorage.getItem('oa-coding-workspaces') ?? '[]') as Array<{ id: string; path: string }>
      expect(saved.map((e) => e.path)).toEqual(['/repo'])
      expect(localStorage.getItem('oa-last-coding-workspace')).toBe(saved[0].id)
    })
  })
})
