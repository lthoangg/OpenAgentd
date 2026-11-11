/**
 * After a reconnect the server replays what was published while the app was
 * away (`stream_resume`, then the missed events). Badges and session states
 * catch up; the only missed notification worth a banner is a question still
 * waiting, and nothing this device already saw shows again.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

const sendDesktopNotification = mock(async (..._args: unknown[]) => ({ status: 'sent', message: 'sent' }))
mock.module('@/lib/desktop-notifications', () => ({ sendDesktopNotification }))
mock.module('@/lib/haptics', () => ({ haptic: () => {}, outcomeHapticFeedback: () => {} }))

const { handleGlobalEvent, resetGlobalNotificationDedupe } = await import('@/hooks/use-global-event-stream')
const { useAgentStore } = await import('@/stores/useAgentStore')
const { useUnreadStore } = await import('@/stores/useUnreadStore')

const client = new QueryClient()
const send = (type: string, data: Record<string, unknown>) => handleGlobalEvent(client, type, data, 1, () => 1)
const resume = (replay: number) => send('stream_resume', { replay, resync: false })
const question = (id: string, sessionId: string) => ({ notification_id: id, session_id: sessionId, kind: 'input_needed', title: 'Needs you · api', body: 'Which package manager?' })
const done = (id: string, sessionId: string) => ({ notification_id: id, session_id: sessionId, kind: 'assistant_done', title: 'Done · api', body: 'Fix the build' })
/** Lets the end-of-replay flush run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  localStorage.clear()
  resetGlobalNotificationDedupe()
  sendDesktopNotification.mockClear()
  useAgentStore.setState({ sessionId: null, isConnected: false, isAgentWorking: false })
  useUnreadStore.setState({ ids: [], failed: [] })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

describe('catching up after a reconnect', () => {
  it('marks a turn that finished while away unread, without a banner', async () => {
    await resume(2)
    await send('session_turn_completed', { session_id: 'away', status: 'completed' })
    await send('desktop_notification', done('n-done', 'away'))
    await settle()

    expect(useUnreadStore.getState().ids).toContain('away')
    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('shows a question asked while away that still waits, once the replay ends', async () => {
    await resume(2)
    await send('desktop_notification', question('n-q', 'asking'))
    expect(sendDesktopNotification).not.toHaveBeenCalled()
    await send('title_update', { session_id: 'other', title: 'Renamed' })
    await settle()

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    expect(sendDesktopNotification.mock.calls[0]).toEqual([
      { kind: 'input_needed', notificationId: 'n-q', sessionId: 'asking', title: 'Needs you · api', body: 'Which package manager?' },
      { force: true, replayed: true },
    ])
  })

  it('says nothing about a question answered while away', async () => {
    await resume(3)
    await send('desktop_notification', question('n-q', 'asking'))
    await send('session_turn_started', { session_id: 'asking' })
    await send('session_turn_completed', { session_id: 'asking', status: 'completed' })
    await settle()

    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('never shows again what this device already saw live', async () => {
    await send('desktop_notification', question('n-live', 'asking'))
    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    // A reload forgets this window's set; the device remembers.
    resetGlobalNotificationDedupe()

    await resume(1)
    await send('desktop_notification', question('n-live', 'asking'))
    await settle()
    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
  })

  it('skips the question card already on screen', async () => {
    useAgentStore.setState({ sessionId: 'asking' })
    await resume(1)
    await send('desktop_notification', question('n-q', 'asking'))
    await settle()
    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('treats events after the replay as live again', async () => {
    await resume(1)
    await send('title_update', { session_id: 'other', title: 'Renamed' })
    await send('desktop_notification', done('n-live-done', 'elsewhere'))
    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    expect(sendDesktopNotification.mock.calls[0][1]).toEqual({ force: false, sessionOnScreen: false })
  })

  it('a fresh stream (nothing to replay) changes nothing', async () => {
    await resume(0)
    await send('desktop_notification', done('n-live-done', 'elsewhere'))
    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
  })
})
