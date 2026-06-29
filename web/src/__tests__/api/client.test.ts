import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cancelQueuedTeamMessage, createWorktree, postTeamChat, resolveApiUrl, resolveTeamSession, setCodingWorkspaceVisibility, updateTeamSessionTitle, workspaceMediaUrl } from '@/api/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete window.__OAD_TOKEN__
})

describe('workspaceMediaUrl', () => {
  it('returns a media proxy URL without token in normal web mode', () => {
    expect(workspaceMediaUrl('sid', 'output/chart.png')).toBe('/api/team/sid/media/output/chart.png')
  })

  it('adds the desktop token query param in desktop mode', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(workspaceMediaUrl('sid', 'output/chart.png')).toBe('/api/team/sid/media/output/chart.png?_token=secret')
  })

  it('adds download before the desktop token for forced downloads', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(workspaceMediaUrl('sid', 'output/chart.png', { download: true })).toBe('/api/team/sid/media/output/chart.png?download=1&_token=secret')
  })
})

describe('resolveApiUrl', () => {
  it('adds the desktop token query param to relative API URLs', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(resolveApiUrl('/api/team/sid/uploads/image.png')).toBe('/api/team/sid/uploads/image.png?_token=secret')
  })

  it('does not add the token to blob or external URLs', () => {
    window.__OAD_TOKEN__ = 'secret'
    expect(resolveApiUrl('blob:http://localhost/1')).toBe('blob:http://localhost/1')
    expect(resolveApiUrl('https://example.com/image.png')).toBe('https://example.com/image.png')
  })
})

describe('postTeamChat', () => {
  it('uses backend detail for non-coding 409 errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ detail: 'conflict' }), { status: 409 }))) as typeof fetch

    await expect(postTeamChat('hello')).rejects.toThrow('conflict')
  })

  it('uses backend detail for coding 409 errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ detail: 'Session belongs to a different coding workspace' }), { status: 409 }))) as typeof fetch

    await expect(postTeamChat('hello', null, false, undefined, 'coding', '/repo/app')).rejects.toThrow(
      'Session belongs to a different coding workspace',
    )
  })

  it('uses backend validation messages for 422 detail arrays', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      JSON.stringify({ detail: [{ msg: 'message is required when interrupt=false.' }] }),
      { status: 422 },
    ))) as typeof fetch

    await expect(postTeamChat('hello')).rejects.toThrow('message is required when interrupt=false.')
  })

  it('sends coding mode and workspace with the chat form', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postTeamChat('hello', null, false, undefined, 'coding', '/repo/app')

    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    expect(form.get('mode')).toBe('coding')
    expect(form.get('workspace')).toBe('/repo/app')
  })

  it('omits model settings when they are undefined', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postTeamChat('hello')

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

    await postTeamChat('hello', 'sid', false, undefined, 'normal', null, null, null)

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

    await postTeamChat('hello', 'sid', false, undefined, 'normal', null, 'openai:gpt-5.5', 'high')

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

    await postTeamChat('hello', 'sid', false, undefined, 'normal', null, 'codex:gpt-5.4', null, false, true)

    const form = body as FormData
    expect(form.get('fast_mode')).toBe('true')
  })

  it('sends shell=true when posting a bang shell command', async () => {
    let body: BodyInit | null | undefined
    globalThis.fetch = mock((_url, init) => {
      body = (init as RequestInit | undefined)?.body
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', session_id: 'sid' })))
    }) as typeof fetch

    await postTeamChat('!ls -la', 'sid', false, undefined, 'normal', null, undefined, undefined, true)

    const form = body as FormData
    expect(form.get('message')).toBe('!ls -la')
    expect(form.get('shell')).toBe('true')
  })

  it('deletes queued messages by session and message id', async () => {
    let url: string | URL | Request | undefined
    let method: string | undefined
    globalThis.fetch = mock((input, init) => {
      url = input as string | URL | Request
      method = (init as RequestInit | undefined)?.method
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch

    await cancelQueuedTeamMessage('sid', 'mid')

    expect(String(url)).toBe('/api/team/sessions/sid/queued-messages/mid')
    expect(method).toBe('DELETE')
  })

  it('treats missing queued messages as already cancelled', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }))) as typeof fetch

    await expect(cancelQueuedTeamMessage('sid', 'mid')).resolves.toBeUndefined()
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

    expect(url).toBe('/api/team/workspace/worktrees')
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

describe('resolveTeamSession', () => {
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
        mode: 'coding',
        workspace: '/repo/app',
        model: 'openai:gpt-5.5',
        thinking_level: 'high',
        created_at: null,
        updated_at: null,
        created: true,
      })))
    }) as typeof fetch

    const result = await resolveTeamSession({
      mode: 'coding',
      workspace: '/repo/app',
      model: 'openai:gpt-5.5',
      thinkingLevel: 'high',
      create: true,
      worktreeFrom: '/repo/main',
      worktreeName: 'task-a',
      worktreeBranch: 'openagentd/task-a',
    })

    expect(url).toBe('/api/team/sessions/resolve')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({
      mode: 'coding',
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
      JSON.stringify({ detail: "workspace is required when mode='coding'." }),
      { status: 422 },
    ))) as typeof fetch

    await expect(resolveTeamSession({ mode: 'coding' })).rejects.toThrow("workspace is required when mode='coding'.")
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

    expect(url).toBe('/api/team/workspace/visibility')
    expect(init?.method).toBe('PATCH')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ workspace: '/repo/app', hidden: true })
    expect(result.workspace).toBe('/repo/app')
    expect(result.hidden).toBe(true)
  })
})

describe('updateTeamSessionTitle', () => {
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

    const result = await updateTeamSessionTitle('sid', 'Renamed session')

    expect(url).toBe('/api/team/sessions/sid')
    expect(init?.method).toBe('PATCH')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ title: 'Renamed session' })
    expect(result.title).toBe('Renamed session')
  })

  it('throws when the backend rejects the title update', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response('bad', { status: 422 }))) as typeof fetch

    await expect(updateTeamSessionTitle('sid', '')).rejects.toThrow('updateTeamSessionTitle failed: 422')
  })
})
