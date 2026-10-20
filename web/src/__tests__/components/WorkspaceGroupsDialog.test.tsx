import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import { WorkspaceGroupsDialog } from '@/components/Sidebar/WorkspaceGroupsDialog'

const originalFetch = globalThis.fetch
let groups: Array<{ id: string; name: string; brief: string | null }> = []
let tags: Record<string, string[]> = {}
let calls: Array<{ method: string; url: string; body: unknown }> = []

beforeEach(() => {
  setApiBaseUrl('')
  groups = [
    { id: 'g-acme', name: 'acme', brief: 'web = frontend' },
    { id: 'g-shared', name: 'shared', brief: null },
  ]
  tags = { '/repo/web': ['g-acme'], '/repo/api': ['g-acme', 'g-shared'] }
  calls = []
  globalThis.fetch = mock(async (input: unknown, rawInit: unknown) => {
    const init = rawInit as RequestInit | undefined
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    if (url.endsWith('/agent/workspace/tree')) {
      return new Response(JSON.stringify({
        repositories: Object.keys(tags).map((path) => ({ path, name: path.split('/').pop(), worktrees: [], group_ids: tags[path] })),
        chat: null,
        groups,
      }))
    }
    if (url.endsWith('/agent/workspace/groups/members')) {
      tags[body.workspace] = body.group_ids
      return new Response(JSON.stringify(body))
    }
    if (url.endsWith('/agent/workspace/groups') && method === 'POST') {
      return new Response(JSON.stringify({ detail: `A group named '${body.name}' already exists.` }), { status: 422 })
    }
    const m = /\/agent\/workspace\/groups\/([^/]+)$/.exec(url)
    if (m && method === 'PATCH') {
      groups = groups.map((g) => (g.id === m[1] ? { ...g, ...body } : g))
      return new Response(JSON.stringify(groups.find((g) => g.id === m[1])))
    }
    if (m && method === 'DELETE') {
      groups = groups.filter((g) => g.id !== m[1])
      for (const path of Object.keys(tags)) tags[path] = tags[path].filter((id) => id !== m[1])
      return new Response(JSON.stringify({ deleted: true }))
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

async function renderDialog(workspace = '/repo/web') {
  const onClose = mock(() => {})
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceGroupsDialog workspace={workspace} label="web" onClose={onClose} />
      </QueryClientProvider>,
    )
  })
  await screen.findByLabelText('In group acme')
  return { onClose }
}

const checkbox = (name: string) => screen.getByLabelText(`In group ${name}`) as HTMLInputElement

describe('WorkspaceGroupsDialog', () => {
  it('shows every group with its brief, member count and this repository\'s tags', async () => {
    await renderDialog()
    expect(screen.getByText('Groups for web')).toBeTruthy()
    expect(checkbox('acme').checked).toBe(true)
    expect(checkbox('shared').checked).toBe(false)
    expect(screen.getByText('web = frontend')).toBeTruthy()
    expect(screen.getByText('· 2')).toBeTruthy()
    expect(screen.getByText('· 1')).toBeTruthy()
  })

  it('saves a tag change at once', async () => {
    const user = userEvent.setup()
    await renderDialog()
    await user.click(checkbox('shared'))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ workspace: '/repo/web', group_ids: ['g-acme', 'g-shared'] }))
    await waitFor(() => expect(checkbox('shared').checked).toBe(true))
  })

  it('edits a group brief and clears it when emptied', async () => {
    const user = userEvent.setup()
    await renderDialog()
    await user.click(screen.getByRole('button', { name: 'Edit group acme' }))
    await user.clear(screen.getByLabelText('Group brief'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'acme', brief: null }))
    await waitFor(() => expect(screen.queryByText('web = frontend')).toBeNull())
  })

  it('asks once more before deleting a group', async () => {
    const user = userEvent.setup()
    await renderDialog()
    await user.click(screen.getByRole('button', { name: 'Delete group shared' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Delete group' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url.endsWith('/agent/workspace/groups/g-shared')).toBe(true))
    await waitFor(() => expect(screen.queryByLabelText('In group shared')).toBeNull())
  })

  it('shows the server error when a group cannot be created', async () => {
    const user = userEvent.setup()
    await renderDialog()
    await user.click(screen.getByRole('button', { name: /new group/i }))
    await user.type(screen.getByLabelText('Group name'), 'ACME')
    await user.click(screen.getByRole('button', { name: 'Create and add' }))
    expect((await screen.findByRole('alert')).textContent).toContain("A group named 'ACME' already exists.")
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})
