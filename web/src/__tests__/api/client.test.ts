import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  cancelQueuedMessage, createAgent, createWorktree, deleteAgent, getAgent,
  listAgentFiles, listMemberProfiles, listSubagents, postAgentChat,
  resolveApiUrl, resolveSession, setCodingWorkspaceVisibility, updateAgent,
  updateSessionTitle, workspaceMediaUrl,
} from '@/api/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete window.__OAD_TOKEN__
})

describe('workspaceMediaUrl', () => {
  it('returns a media proxy URL without token in browser mode', () => {
    expect(workspaceMediaUrl('sid', 'output/chart.png')).toBe('/api/agent/sid/media/output/chart.png')
  })

  it('adds the desktop token query param in desktop mode', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(workspaceMediaUrl('sid', 'output/chart.png')).toBe('/api/agent/sid/media/output/chart.png?_token=secret')
  })

  it('adds download before the desktop token for forced downloads', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(workspaceMediaUrl('sid', 'output/chart.png', { download: true })).toBe('/api/agent/sid/media/output/chart.png?download=1&_token=secret')
  })
})

describe('resolveApiUrl', () => {
  it('adds the desktop token query param to relative API URLs', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(resolveApiUrl('/api/agent/sid/uploads/image.png')).toBe('/api/agent/sid/uploads/image.png?_token=secret')
  })

  it('does not add the token to blob or external URLs', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(resolveApiUrl('blob:http://localhost/1')).toBe('blob:http://localhost/1')
    expect(resolveApiUrl('https://example.com/image.png')).toBe('https://example.com/image.png')
  })
})

describe('postAgentChat', () => {
  it('uses backend detail for invalid 409 errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ detail: 'conflict' }), { status: 409 }))) as typeof fetch

    await expect(postAgentChat('hello', null, false, '/repo/app')).rejects.toThrow('conflict')
  })

  it('uses backend detail for coding 409 errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ detail: 'Session belongs to a different coding workspace' }), { status: 409 }))) as typeof fetch

    await expect(postAgentChat('hello', null, false, '/repo/app')).rejects.toThrow(
      'Session belongs to a different coding workspace',
    )
  })

  it('uses backend validation messages for 422 detail arrays', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      JSON.stringify({ detail: [{ msg: 'message is required when interrupt=false.' }] }),
      { status: 422 },
    ))) as typeof fetch

    await expect(postAgentChat('hello', null, false, '/repo/app')).rejects.toThrow('message is required when interrupt=false.')
  })

  it('sends workspace with the chat form', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postAgentChat('hello', null, false, '/repo/app')

    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    expect(form.get('workspace')).toBe('/repo/app')
  })

  it('omits model settings when they are undefined', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postAgentChat('hello', null, false, '/repo/app')

    const init = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0][1] as RequestInit | undefined
    expect(init?.headers).toEqual({ Accept: 'application/json' })
    const form = body as FormData
    expect(form.has('model')).toBe(false)
    expect(form.has('thinking_level')).toBe(false)
  })

  it('sends empty form fields for explicit model setting resets', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postAgentChat('hello', 'sid', false, '/tmp', undefined, null, null, false)

    const form = body as FormData
    expect(form.has('model')).toBe(true)
    expect(form.get('model')).toBe('')
    expect(form.has('thinking_level')).toBe(true)
    expect(form.get('thinking_level')).toBe('')
  })

  it('sends selected model settings exactly when provided', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postAgentChat('hello', 'sid', false, '/tmp', undefined, 'openai:gpt-5.5', 'high')

    const form = body as FormData
    expect(form.get('model')).toBe('openai:gpt-5.5')
    expect(form.get('thinking_level')).toBe('high')
  })

  it('sends fast_mode only when requested', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postAgentChat('hello', 'sid', false, '/tmp', undefined, 'codex:gpt-5.4', null, true)

    const form = body as FormData
    expect(form.get('fast_mode')).toBe('true')
  })

  it('deletes queued messages by session and message id', async () => {
    let url: string | URL | Request | undefined
    let method: string | undefined
    globalThis.fetch = mock((input, init) => {
      url = input as string | URL | Request
      method = (init as RequestInit | undefined)?.method
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch

    await cancelQueuedMessage('sid', 'mid')

    expect(String(url)).toBe('/api/agent/sessions/sid/queued-messages/mid')
    expect(method).toBe('DELETE')
  })

  it('treats missing queued messages as already cancelled', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }))) as typeof fetch

    await expect(cancelQueuedMessage('sid', 'mid')).resolves.toBeUndefined()
  })
})

describe('createWorktree', () => {
  it('posts source workspace and optional branch data as JSON', async () => {
    let url = ''
    let init: RequestInit | undefined
    globalThis.fetch = mock((input, requestInit) => {
      url = String(input)
      init = requestInit as RequestInit | undefined
      return Promise.resolve(new Response(JSON.stringify({
        name: 'feature-login',
        directory: '/data/worktrees/repo/feature-login',
        branch: 'openagentd/feature-login',
        source_workspace: '/repo/app',
      })))
    }) as typeof fetch

    const result = await createWorktree({
      sourceWorkspace: '/repo/app',
      name: 'feature-login',
      branch: 'openagentd/feature-login',
    })

    expect(url).toBe('/api/agent/workspace/worktrees')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({
      source_workspace: '/repo/app',
      name: 'feature-login',
      branch: 'openagentd/feature-login',
    })
    expect(result.directory).toBe('/data/worktrees/repo/feature-login')
  })
})

describe('resolveSession', () => {
  it('posts mode, workspace, and model settings as JSON', async () => {
    let url = ''
    let init: RequestInit | undefined
    globalThis.fetch = mock((input, requestInit) => {
      url = String(input)
      init = requestInit as RequestInit | undefined
      return Promise.resolve(new Response(JSON.stringify({
        id: 'sid',
        title: null,
        agent_name: null,
        workspace: '/repo/app',
        model: 'openai:gpt-5.5',
        thinking_level: 'high',
        created_at: null,
        updated_at: null,
        created: true,
      })))
    }) as typeof fetch

    const result = await resolveSession({
      workspace: '/repo/app',
      model: 'openai:gpt-5.5',
      thinkingLevel: 'high',
      create: true,
      worktreeFrom: '/repo/main',
      worktreeName: 'task-a',
      worktreeBranch: 'openagentd/task-a',
    })

    expect(url).toBe('/api/agent/sessions/resolve')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({
      workspace: '/repo/app',
      model: 'openai:gpt-5.5',
      thinking_level: 'high',
      create: true,
      worktree_from: '/repo/main',
      worktree_name: 'task-a',
      worktree_branch: 'openagentd/task-a',
    })
    expect(result.created).toBe(true)
    expect(result.id).toBe('sid')
  })

  it('throws backend detail when backend rejects resolve request', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      JSON.stringify({ detail: 'workspace is required.' }),
      { status: 422 },
    ))) as typeof fetch

    await expect(resolveSession({ workspace: '/repo/app' })).rejects.toThrow('workspace is required.')
  })
})

describe('setCodingWorkspaceVisibility', () => {
  it('patches workspace visibility as JSON', async () => {
    let url = ''
    let init: RequestInit | undefined
    globalThis.fetch = mock((input, requestInit) => {
      url = String(input)
      init = requestInit as RequestInit | undefined
      return Promise.resolve(new Response(JSON.stringify({ workspace: '/repo/app', hidden: true })))
    }) as typeof fetch

    const result = await setCodingWorkspaceVisibility('/repo/app', true)

    expect(url).toBe('/api/agent/workspace/visibility')
    expect(init?.method).toBe('PATCH')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ workspace: '/repo/app', hidden: true })
    expect(result.workspace).toBe('/repo/app')
    expect(result.hidden).toBe(true)
  })
})

describe('updateSessionTitle', () => {
  it('patches only the title as JSON and returns the updated session', async () => {
    let url = ''
    let init: RequestInit | undefined
    globalThis.fetch = mock((input, requestInit) => {
      url = String(input)
      init = requestInit as RequestInit | undefined
      return Promise.resolve(new Response(JSON.stringify({
        id: 'sid',
        title: 'Renamed session',
        agent_name: 'lead',
        created_at: null,
        updated_at: null,
      })))
    }) as typeof fetch

    const result = await updateSessionTitle('sid', 'Renamed session')

    expect(url).toBe('/api/agent/sessions/sid')
    expect(init?.method).toBe('PATCH')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ title: 'Renamed session' })
    expect(result.title).toBe('Renamed session')
  })

  it('throws when the backend rejects the title update', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response('bad', { status: 422 }))) as typeof fetch

    await expect(updateSessionTitle('sid', '')).rejects.toThrow('updateSessionTitle failed: 422')
  })
})

describe('subagents API', () => {
  it('fetches subagents for a session', async () => {
    let url = ''
    globalThis.fetch = mock((input) => {
      url = String(input)
      return Promise.resolve(new Response(JSON.stringify({
        available_profiles: [{ name: 'explorer', tools: ['read'] }],
        live_members: [{ member_id: 'explorer#1', status: 'working' }],
      })))
    }) as typeof fetch

    const res = await listSubagents('session-123')
    expect(url).toBe('/api/agent/sessions/session-123/subagents')
    expect(res.available_profiles.length).toBe(1)
    expect(res.live_members[0].member_id).toBe('explorer#1')
  })

  it('fetches member profiles from /agents/members', async () => {
    let url = ''
    globalThis.fetch = mock((input) => {
      url = String(input)
      return Promise.resolve(new Response(JSON.stringify([
        { name: 'explorer', tools: ['glob', 'read'] },
        { name: 'researcher', tools: ['web_search'] },
      ])))
    }) as typeof fetch

    const res = await listMemberProfiles()
    expect(url).toBe('/api/agents/members')
    expect(res.length).toBe(2)
    expect(res[0].name).toBe('explorer')
  })

  it('lists agent files via /agents', async () => {
    let url = ''
    globalThis.fetch = mock((input) => {
      url = String(input)
      return Promise.resolve(new Response(JSON.stringify({
        agents: [
          { name: 'code', role: 'lead' },
          { name: 'explorer', role: 'member' },
        ],
      })))
    }) as typeof fetch

    const res = await listAgentFiles()
    expect(url).toBe('/api/agents')
    expect(res.agents.length).toBe(2)
    expect(res.agents[0].name).toBe('code')
    expect(res.agents[1].name).toBe('explorer')
  })

  it('manages agents via CRUD methods', async () => {
    const calls: { url: string; method?: string }[] = []
    globalThis.fetch = mock((input: any, init?: any) => {
      calls.push({ url: String(input), method: init?.method })
      return Promise.resolve(new Response(JSON.stringify({
        name: 'reviewer',
        path: '/tmp/reviewer.md',
        content: '---\nname: reviewer\n---\nPrompt',
      })))
    }) as typeof fetch

    await getAgent('reviewer')
    expect(calls[0]).toEqual({ url: '/api/agents/reviewer', method: undefined })

    await createAgent('reviewer', 'content')
    expect(calls[1]).toEqual({ url: '/api/agents', method: 'POST' })

    await updateAgent('reviewer', 'updated content')
    expect(calls[2]).toEqual({ url: '/api/agents/reviewer', method: 'PUT' })

    globalThis.fetch = mock((input: any, init?: any) => {
      calls.push({ url: String(input), method: init?.method })
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch
    await deleteAgent('reviewer')
    expect(calls[3]).toEqual({ url: '/api/agents/reviewer', method: 'DELETE' })
  })
})
