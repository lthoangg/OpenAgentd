import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { setApiBaseUrl } from '@/api/base-url'

const sendDesktopNotification = mock(async () => ({ status: 'sent', message: 'sent' }))
mock.module('@/lib/desktop-notifications', () => ({ sendDesktopNotification }))
type GlobalCallbacks = { onOpen?: () => void; onEvent?: (type: string, data: unknown) => void }
let globalCallbacks: GlobalCallbacks | null = null
let globalSignals: AbortSignal[] = []
const globalEventStream = mock((...args: unknown[]) => {
  globalCallbacks = args[0] as GlobalCallbacks
  globalSignals.push(args[1] as AbortSignal)
})
mock.module('@/api/global-events', () => ({ globalEventStream }))

import { GlobalEventStream, handleGlobalEvent, reconcileCurrentSession, resetGlobalNotificationDedupe } from '@/hooks/use-global-event-stream'
import { queryKeys } from '@/queries'
import { useTeamStore } from '@/stores/useTeamStore'
import { useLspInstallStore } from '@/stores/useLspInstallStore'

const INITIAL = {
  sessionId: null as string | null,
  sessionTitle: null as string | null,
  _workspace: null as string | null,
  _sessionGeneration: 0,
  isConnected: false,
}

beforeEach(() => {
  setApiBaseUrl('')
  useTeamStore.setState(INITIAL)
  sendDesktopNotification.mockClear()
  resetGlobalNotificationDedupe()
  globalEventStream.mockClear()
  globalCallbacks = null
  globalSignals = []
  useLspInstallStore.setState({ request: null })
})

afterEach(cleanup)

it('opens the global stream in the shared frontend runtime', () => {
  const client = new QueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(GlobalEventStream)))

  expect(globalEventStream).toHaveBeenCalledTimes(1)
})

it('replaces the global stream on a backend switch and ignores old-backend LSP events', async () => {
  const client = new QueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(GlobalEventStream)))
  const oldCallbacks = globalCallbacks
  const oldSignal = globalSignals[0]

  setApiBaseUrl('http://127.0.0.1:5001')

  expect(globalEventStream).toHaveBeenCalledTimes(2)
  expect(oldSignal?.aborted).toBe(true)
  oldCallbacks?.onEvent?.('lsp_install_required', {
    component: 'typescript', workspace: '/old-backend', downloads_enabled: true,
    language_server_version: '4.3.3', typescript_version: '5.8.2',
  })
  await waitFor(() => expect(useLspInstallStore.getState().request).toBeNull())
})

it('reconciles the active session whenever the global connection opens', async () => {
  const client = new QueryClient()
  const loadSession = mock(async () => { useTeamStore.setState({ isTeamWorking: true }) })
  const connectStream = mock(() => new AbortController())
  useTeamStore.setState({ sessionId: 'current', loadSession, connectStream })
  render(createElement(QueryClientProvider, { client }, createElement(GlobalEventStream)))

  globalCallbacks?.onOpen?.()

  await waitFor(() => expect(loadSession).toHaveBeenCalledWith('current', null))
  expect(connectStream).toHaveBeenCalledTimes(1)
})

describe('handleGlobalEvent', () => {
  it('invalidates sessions and scheduler then restores and streams the current scheduled session', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.team.sessions.infinite(), { pages: [], pageParams: [] })
    client.setQueryData(queryKeys.scheduler.list(), [])
    const loadSession = mock(async () => {})
    const connectStream = mock(() => new AbortController())
    useTeamStore.setState({
      sessionId: 'current',
      _workspace: '/workspace',
      _sessionGeneration: 4,
      loadSession,
      connectStream,
    })

    await handleGlobalEvent(client, 'session_turn_started', {
      session_id: 'current', source: 'scheduled_task', task_slug: 'daily', task_name: 'Daily',
      mode: 'coding', workspace: '/workspace', started_at: '2026-07-13T12:00:00Z',
    }, 1, () => 1)

    expect(client.getQueryState(queryKeys.team.sessions.infinite())?.isInvalidated).toBe(true)
    expect(client.getQueryState(queryKeys.scheduler.list())?.isInvalidated).toBe(true)
    expect(loadSession).toHaveBeenCalledWith('current', '/workspace')
    expect(connectStream).toHaveBeenCalledTimes(1)
  })

  it('does not restore or connect after a session-generation change', async () => {
    const client = new QueryClient()
    const loadSession = mock(async () => { useTeamStore.setState({ _sessionGeneration: 2 }) })
    const connectStream = mock(() => new AbortController())
    useTeamStore.setState({ sessionId: 'current', _sessionGeneration: 1, loadSession, connectStream })

    await handleGlobalEvent(client, 'session_turn_started', { session_id: 'current' }, 1, () => 1)

    expect(connectStream).not.toHaveBeenCalled()
  })

  it('reconciles only the turn tail on session_turn_completed', async () => {
    const client = new QueryClient()
    const reconcileTurnTail = mock(async () => {})
    const loadSession = mock(async () => {})
    // The shared harness beforeEach resets *state*, not actions — restore the
    // real action so the fallback-path tests below still exercise it.
    const realReconcile = useTeamStore.getState().reconcileTurnTail
    useTeamStore.setState({
      sessionId: 'current',
      _workspace: '/workspace',
      reconcileTurnTail,
      loadSession,
    })

    try {
      await handleGlobalEvent(client, 'session_turn_completed', {
        session_id: 'current', status: 'completed',
      }, 1, () => 1)

      // The live stream already delivered this turn; re-downloading the whole
      // page (over a megabyte on an active session) is what this avoids.
      expect(reconcileTurnTail).toHaveBeenCalledWith('current', '/workspace')
      expect(loadSession).not.toHaveBeenCalled()
    } finally {
      useTeamStore.setState({ reconcileTurnTail: realReconcile })
    }
  })

  // ``reconcileTurnTail`` falls back to a full ``loadSession`` when it has no
  // synced baseline, which is the case in these two legacy tests.
  it('invalidates sessions and reloads the current session on session_turn_completed', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.team.sessions.infinite(), { pages: [], pageParams: [] })
    const loadSession = mock(async () => {})
    useTeamStore.setState({
      sessionId: 'current',
      _workspace: '/workspace',
      loadSession,
    })

    await handleGlobalEvent(client, 'session_turn_completed', {
      session_id: 'current',
      status: 'completed',
    }, 1, () => 1)

    expect(client.getQueryState(queryKeys.team.sessions.infinite())?.isInvalidated).toBe(true)
    expect(loadSession).toHaveBeenCalledWith('current', '/workspace')
  })

  it('invalidates sessions and reloads the current session on session_turn_completed (stopped)', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.team.sessions.infinite(), { pages: [], pageParams: [] })
    const loadSession = mock(async () => {})
    useTeamStore.setState({
      sessionId: 'current',
      _workspace: '/workspace',
      loadSession,
    })

    await handleGlobalEvent(client, 'session_turn_completed', {
      session_id: 'current',
      status: 'stopped',
    }, 1, () => 1)

    expect(client.getQueryState(queryKeys.team.sessions.infinite())?.isInvalidated).toBe(true)
    expect(loadSession).toHaveBeenCalledWith('current', '/workspace')
  })

  // A turn ending only flips the row's ``running`` flag. Invalidating instead
  // refetched every loaded page of the infinite session list sequentially, on
  // every single turn.
  it('patches running in place on session_turn_completed without refetching the list', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.team.sessions.infinite(), {
      pages: [{
        data: [{ id: 'current', title: 'T', agent_name: 'lead', created_at: null, updated_at: null, running: true }],
        next_cursor: null,
        has_more: false,
      }],
      pageParams: [null],
    })
    useTeamStore.setState({ sessionId: 'current', _workspace: null, loadSession: mock(async () => {}) })

    await handleGlobalEvent(client, 'session_turn_completed', {
      session_id: 'current', status: 'completed',
    }, 1, () => 1)

    expect(client.getQueryState(queryKeys.team.sessions.infinite())?.isInvalidated).toBe(false)
    const data = client.getQueryData(queryKeys.team.sessions.infinite()) as {
      pages: { data: { running?: boolean }[] }[]
    }
    expect(data.pages[0].data[0].running).toBe(false)
  })

  // Interactive turns vastly outnumber scheduled ones, and a turn that really
  // touched the scheduler already enqueues its own `scheduler` invalidation
  // from the tool_end reducer.
  it('does not invalidate the scheduler list on session_turn_completed', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.scheduler.list(), [])
    useTeamStore.setState({ sessionId: 'other', loadSession: mock(async () => {}) })

    await handleGlobalEvent(client, 'session_turn_completed', {
      session_id: 'current', status: 'completed',
    }, 1, () => 1)

    expect(client.getQueryState(queryKeys.scheduler.list())?.isInvalidated).toBe(false)
  })

  it('reconciles the active session on resume and attaches its stream only when REST reports it working', async () => {
    const loadSession = mock(async () => { useTeamStore.setState({ isTeamWorking: true }) })
    const connectStream = mock(() => new AbortController())
    useTeamStore.setState({
      sessionId: 'current',
      _workspace: '/workspace',
      _sessionGeneration: 4,
      isTeamWorking: false,
      loadSession,
      connectStream,
    })

    await reconcileCurrentSession(2, () => 2)

    expect(loadSession).toHaveBeenCalledWith('current', '/workspace')
    expect(connectStream).toHaveBeenCalledTimes(1)
  })

  it('patches the active title and cached session detail without opening a stream', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.team.sessions.detail('current'), { id: 'current', title: 'Old' })
    const connectStream = mock(() => new AbortController())
    useTeamStore.setState({ sessionId: 'current', connectStream })

    await handleGlobalEvent(client, 'title_update', { session_id: 'current', title: 'New', updated_at: '2026-07-13T12:00:00Z' }, 1, () => 1)

    expect(useTeamStore.getState().sessionTitle).toBe('New')
    expect(client.getQueryData(queryKeys.team.sessions.detail('current'))).toEqual({ id: 'current', title: 'New' })
    expect(connectStream).not.toHaveBeenCalled()
  })

  it('prompts for TypeScript tooling only when backend downloads are enabled', async () => {
    const client = new QueryClient()
    const payload = {
      component: 'typescript', workspace: '/workspace', downloads_enabled: true,
      language_server_version: '4.3.3', typescript_version: '5.8.2',
    }

    expect(await handleGlobalEvent(client, 'lsp_install_required', payload, 1, () => 1)).toBe(true)
    expect(useLspInstallStore.getState().request).toEqual({
      workspace: '/workspace', languageServerVersion: '4.3.3', typeScriptVersion: '5.8.2',
    })

    useLspInstallStore.getState().dismiss()
    expect(await handleGlobalEvent(client, 'lsp_install_required', { ...payload, downloads_enabled: false }, 1, () => 1)).toBe(false)
    expect(useLspInstallStore.getState().request).toBeNull()
  })

  it('deduplicates replayed desktop notifications by notification_id', async () => {
    const client = new QueryClient()
    const payload = { notification_id: 'notice-1', session_id: 'current', kind: 'assistant_done', title: 'Done', body: 'Task done' }

    await handleGlobalEvent(client, 'desktop_notification', payload, 1, () => 1)
    await handleGlobalEvent(client, 'desktop_notification', payload, 1, () => 1)

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
  })

  it('ignores background task completion notifications', async () => {
    const client = new QueryClient()
    const payload = { notification_id: 'notice-2', session_id: 'current', kind: 'background_done', title: 'Background task completed', body: 'Task done' }

    const handled = await handleGlobalEvent(client, 'desktop_notification', payload, 1, () => 1)

    expect(handled).toBe(false)
    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })
})
