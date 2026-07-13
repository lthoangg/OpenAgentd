import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'

const sendDesktopNotification = mock(async () => ({ status: 'sent', message: 'sent' }))
mock.module('@/lib/desktop-notifications', () => ({ sendDesktopNotification }))
let globalCallbacks: { onOpen?: () => void } | null = null
const globalEventStream = mock((...args: unknown[]) => {
  globalCallbacks = args[0] as { onOpen?: () => void }
})
mock.module('@/api/global-events', () => ({ globalEventStream }))

import { GlobalEventStream, handleGlobalEvent, reconcileCurrentSession, resetGlobalNotificationDedupe } from '@/hooks/use-global-event-stream'
import { queryKeys } from '@/queries'
import { useTeamStore } from '@/stores/useTeamStore'

const INITIAL = {
  sessionId: null as string | null,
  sessionTitle: null as string | null,
  _workspace: null as string | null,
  _sessionGeneration: 0,
  isConnected: false,
}

beforeEach(() => {
  useTeamStore.setState(INITIAL)
  sendDesktopNotification.mockClear()
  resetGlobalNotificationDedupe()
  globalEventStream.mockClear()
  globalCallbacks = null
})

afterEach(cleanup)

it('opens the global stream in the shared frontend runtime', () => {
  const client = new QueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(GlobalEventStream)))

  expect(globalEventStream).toHaveBeenCalledTimes(1)
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

  it('deduplicates replayed desktop notifications by notification_id', async () => {
    const client = new QueryClient()
    const payload = { notification_id: 'notice-1', session_id: 'current', kind: 'assistant_done', title: 'Done', body: 'Task done' }

    await handleGlobalEvent(client, 'desktop_notification', payload, 1, () => 1)
    await handleGlobalEvent(client, 'desktop_notification', payload, 1, () => 1)

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
  })
})
