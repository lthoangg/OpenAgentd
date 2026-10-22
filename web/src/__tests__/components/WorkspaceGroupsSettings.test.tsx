import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import { WorkspaceGroupsSettings } from '@/components/settings/WorkspaceGroupsSettings'
import { suggestedGroupColor } from '@/components/Sidebar/groupColor'

const originalFetch = globalThis.fetch
let groups: Array<{ id: string; name: string; brief: string | null; color?: string | null }> = []
let tags: Record<string, string[]> = {}
let calls: Array<{ method: string; url: string; body: unknown }> = []
/** When set, membership saves wait on it; resolve with `false` to refuse the save. */
let holdPut: Promise<boolean> | null = null

beforeEach(() => {
  setApiBaseUrl('')
  groups = [
    { id: 'g-acme', name: 'acme', brief: 'web = frontend', color: null },
    { id: 'g-shared', name: 'shared', brief: null, color: '#10b981' },
  ]
  tags = { '/repo/web': ['g-acme'], '/repo/api': ['g-acme', 'g-shared'], '/repo/docs': [] }
  calls = []
  holdPut = null
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
      if (holdPut && !(await holdPut)) {
        return new Response(JSON.stringify({ detail: 'Workspace is gone.' }), { status: 409 })
      }
      tags[body.workspace] = body.group_ids
      return new Response(JSON.stringify(body))
    }
    if (url.endsWith('/agent/workspace/groups') && method === 'POST') {
      if (groups.some((g) => g.name.toLowerCase() === body.name.toLowerCase())) {
        return new Response(JSON.stringify({ detail: `A group named '${body.name}' already exists.` }), { status: 422 })
      }
      const created = { id: `g-${body.name}`, name: body.name, brief: body.brief ?? null, color: body.color ?? null }
      groups = [...groups, created]
      return new Response(JSON.stringify({ ...created, members: [] }))
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

async function renderSettings(ready = 'acme') {
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceGroupsSettings />
      </QueryClientProvider>,
    )
  })
  await screen.findByText(ready)
}

const members = (group: string) =>
  within(screen.getByRole('list', { name: `Members of ${group}` })).getAllByRole('listitem').map((li) => li.textContent)
const puts = () => calls.filter((c) => c.method === 'PUT').map((c) => c.body)
const colorInput = () => screen.getByLabelText('Group colour') as HTMLInputElement
const colorPicker = () => screen.getByLabelText('Pick group colour') as HTMLInputElement

describe('WorkspaceGroupsSettings', () => {
  it('lists every group with its brief and member workspaces', async () => {
    await renderSettings()
    expect(screen.getByText('web = frontend')).toBeTruthy()
    expect(members('acme')).toEqual(['web', 'api'])
    expect(members('shared')).toEqual(['api'])
  })

  it('adds a workspace to a group, offering only workspaces not in it', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Add a workspace to shared' }))
    const options = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(options).toEqual(['web', 'docs'])
    await user.click(screen.getByRole('menuitem', { name: 'docs' }))
    await waitFor(() => expect(puts()).toEqual([{ workspace: '/repo/docs', group_ids: ['g-shared'] }]))
    await waitFor(() => expect(members('shared')).toEqual(['api', 'docs']))
  })

  it('removes a workspace from one group and keeps its other groups', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Remove api from acme' }))
    await waitFor(() => expect(puts()).toEqual([{ workspace: '/repo/api', group_ids: ['g-shared'] }]))
    await waitFor(() => expect(members('acme')).toEqual(['web']))
  })

  it('drops a removed workspace before the server answers', async () => {
    let answer: (ok: boolean) => void = () => {}
    holdPut = new Promise((resolve) => { answer = resolve })
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Remove api from acme' }))
    await waitFor(() => expect(members('acme')).toEqual(['web']))
    expect(tags['/repo/api']).toEqual(['g-acme', 'g-shared'])
    await act(async () => { answer(true) })
    await waitFor(() => expect(tags['/repo/api']).toEqual(['g-shared']))
    expect(members('acme')).toEqual(['web'])
  })

  it('takes several membership changes in a row without waiting for each save', async () => {
    let answer: (ok: boolean) => void = () => {}
    holdPut = new Promise((resolve) => { answer = resolve })
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Remove api from acme' }))
    await user.click(screen.getByRole('button', { name: 'Remove web from acme' }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Members of acme' })).toBeNull())
    await act(async () => { answer(true) })
    await waitFor(() => expect(tags).toEqual({ '/repo/web': [], '/repo/api': ['g-shared'], '/repo/docs': [] }))
  })

  it('puts a workspace back and says why when the server refuses the change', async () => {
    holdPut = Promise.resolve(false)
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Remove api from acme' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Workspace is gone.')
    expect(members('acme')).toEqual(['web', 'api'])
  })

  it('creates a group in a suggested colour, without tagging any workspace', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: /new group/i }))
    expect(colorInput().value).toBe(suggestedGroupColor(2))
    await user.type(screen.getByLabelText('Group name'), 'billing')
    await user.type(screen.getByLabelText('Group brief'), 'invoices')
    await user.click(screen.getByRole('button', { name: 'Create group' }))
    await screen.findByText('billing')
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'billing', brief: 'invoices', color: suggestedGroupColor(2) })
    expect(puts()).toEqual([])
    expect(screen.queryByLabelText('Group name')).toBeNull()
  })

  it('creates a group in any picked colour', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: /new group/i }))
    await user.type(screen.getByLabelText('Group name'), 'billing')
    fireEvent.change(colorPicker(), { target: { value: '#ff00aa' } })
    expect(colorInput().value).toBe('#ff00aa')
    await user.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'billing', brief: null, color: '#ff00aa' }))
  })

  it('takes a typed hex colour as soon as it parses', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: /new group/i }))
    await user.type(screen.getByLabelText('Group name'), 'billing')
    await user.clear(colorInput())
    await user.type(colorInput(), 'F0A')
    // The swatch follows the typed value before the field loses focus.
    expect(colorPicker().value).toBe('#ff00aa')
    await user.tab()
    expect(colorInput().value).toBe('#ff00aa')
    await user.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'billing', brief: null, color: '#ff00aa' }))
  })

  it('holds back a group whose hex colour does not parse', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: /new group/i }))
    await user.type(screen.getByLabelText('Group name'), 'billing')
    await user.clear(colorInput())
    await user.type(colorInput(), '#12')
    expect(colorInput().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Use a hex colour such as #3b82f6.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true)
    await user.type(colorInput(), '3')
    expect(colorInput().getAttribute('aria-invalid')).toBeNull()
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('changes a group colour', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Edit group shared' }))
    expect(colorInput().value).toBe('#10b981')
    await user.clear(colorInput())
    await user.type(colorInput(), '#EF4444')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'shared', brief: null, color: '#ef4444' }))
  })

  it('shows the server error when a group cannot be created', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: /new group/i }))
    await user.type(screen.getByLabelText('Group name'), 'ACME')
    await user.click(screen.getByRole('button', { name: 'Create group' }))
    expect((await screen.findByRole('alert')).textContent).toContain("A group named 'ACME' already exists.")
    expect(screen.getByLabelText('Group name')).toBeTruthy()
  })

  it('edits a group brief, clearing it when emptied, and leaves an untouched colour alone', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Edit group acme' }))
    await user.clear(screen.getByLabelText('Group brief'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // acme has no picked colour; saving must not pin the derived one.
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'acme', brief: null }))
    await waitFor(() => expect(screen.queryByText('web = frontend')).toBeNull())
  })

  it('asks once more before deleting a group', async () => {
    const user = userEvent.setup()
    await renderSettings()
    await user.click(screen.getByRole('button', { name: 'Delete group shared' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(screen.getByText(/It is removed from 1 workspace\./)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByRole('button', { name: 'Delete group' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Delete group shared' }))
    await user.click(screen.getByRole('button', { name: 'Delete group' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url.endsWith('/agent/workspace/groups/g-shared')).toBe(true))
    await waitFor(() => expect(screen.queryByText('shared')).toBeNull())
  })

  it('explains what to do when there are no groups yet', async () => {
    groups = []
    for (const path of Object.keys(tags)) tags[path] = []
    await renderSettings('No groups yet')
    expect(screen.getByRole('button', { name: /new group/i })).toBeTruthy()
  })
})
