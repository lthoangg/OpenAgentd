import { afterEach, describe, expect, it, mock } from 'bun:test'
import { render, waitFor } from '@testing-library/react'

// The hook reads the router from context; supply a stub without mounting the
// route tree.
const navigate = mock(async () => {})
let pathname = '/'
const router = { navigate, state: { location: { get pathname() { return pathname } } } }
mock.module('@tanstack/react-router', () => ({ useRouter: () => router }))

// Mobile notification taps come from the notification library, not the event bus.
let tapListener: ((sessionId: string) => void) | null = null
mock.module('@/lib/desktop-notifications', () => ({
  listenForNotificationTaps: async (cb: (sessionId: string) => void) => {
    tapListener = cb
    return () => { tapListener = null }
  },
}))

import { useDesktopCommands } from '@/lib/desktop-commands'
import { nextNeedsYouSessionId } from '@/lib/desktop-commands'
import { APP_EVENTS } from '@/lib/app-events'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

let listener: ((event: { payload: unknown }) => void) | null = null
let notificationListener: ((event: { payload: unknown }) => void) | null = null
let unlistenCalls = 0
let commandListenOptions: unknown = undefined
let notificationListenOptions: unknown = undefined

mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: (event: { payload: unknown }) => void, options?: unknown) => {
    if (event === 'desktop-command') {
      listener = cb
      commandListenOptions = options
    } else {
      notificationListener = cb
      notificationListenOptions = options
    }
    return () => {
      unlistenCalls += 1
      if (event === 'desktop-command') listener = null
      else notificationListener = null
    }
  },
}))

function Harness() {
  useDesktopCommands()
  return null
}

async function renderBridge() {
  const view = render(<Harness />)
  await waitFor(() => expect(listener).not.toBeNull())
  return view
}

function resetUIStore(): void {
  useUIStore.setState({
    schedulerOpen: false,
    runPickerOpen: false,
    paletteOpen: false,
  })
  listener = null
  notificationListener = null
  tapListener = null
  unlistenCalls = 0
  navigate.mockClear()
  pathname = '/'
  queryClient.removeQueries({ queryKey: queryKeys.session.sessions.active() })
  useDisplayPrefsStore.setState({ textSize: 'default' })
}

afterEach(resetUIStore)

/** Collect synthetic shortcut keydowns while ``run`` executes. */
async function captureKeys(run: () => Promise<void>): Promise<KeyboardEvent[]> {
  const events: KeyboardEvent[] = []
  const onKeyDown = (event: KeyboardEvent) => events.push(event)
  window.addEventListener('keydown', onKeyDown)
  try {
    await run()
  } finally {
    window.removeEventListener('keydown', onKeyDown)
  }
  return events
}

/** Collect app events (shell actions without a shortcut) while ``run`` executes. */
async function captureAppEvents(run: () => Promise<void>): Promise<string[]> {
  const events: string[] = []
  const names = Object.values(APP_EVENTS)
  const onEvent = (event: Event) => events.push(event.type)
  names.forEach((name) => window.addEventListener(name, onEvent))
  try {
    await run()
  } finally {
    names.forEach((name) => window.removeEventListener(name, onEvent))
  }
  return events
}

describe('useDesktopCommands', () => {
  it('asks the shell to toggle the scheduler without a keyboard shortcut', async () => {
    let keys: KeyboardEvent[] = []
    const appEvents = await captureAppEvents(async () => {
      keys = await captureKeys(async () => {
        await renderBridge()
        listener?.({ payload: 'scheduler' })
      })
    })

    expect(appEvents).toEqual([APP_EVENTS.toggleScheduler])
    expect(keys).toHaveLength(0)
    // The store flag is left to the shell's handler, which picks dock tab or overlay.
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })

  it.each([
    ['new_session', 'n'],
    ['toggle_sidebar', 'b'],
  ])('routes %s through its in-app shortcut', async (command, key) => {
    const events = await captureKeys(async () => {
      await renderBridge()
      listener?.({ payload: command })
    })

    expect(events.map((e) => [e.key, e.ctrlKey, e.metaKey, e.shiftKey])).toEqual([[key, true, false, false]])
  })

  it.each([
    ['open_workspace', APP_EVENTS.openWorkspace],
    ['terminal', APP_EVENTS.openTerminal],
  ])('routes %s to the shell as an app event', async (command, event) => {
    const appEvents = await captureAppEvents(async () => {
      await renderBridge()
      listener?.({ payload: command })
    })

    expect(appEvents).toEqual([event])
  })

  it('toggles session settings through the shared UI store', async () => {
    await renderBridge()

    listener?.({ payload: 'agent_capabilities' })
    expect(useUIStore.getState().runPickerOpen).toBe(true)
  })

  it.each([
    ['split_review_panel', APP_EVENTS.splitReviewPanel],
    ['split_review_panel_down', APP_EVENTS.splitReviewPanelDown],
    ['reset_layout', APP_EVENTS.resetLayout],
  ])('routes the View menu item %s to its layout event', async (command, event) => {
    let keys: KeyboardEvent[] = []
    const appEvents = await captureAppEvents(async () => {
      keys = await captureKeys(async () => {
        await renderBridge()
        listener?.({ payload: command })
      })
    })

    expect(appEvents).toEqual([event])
    expect(keys).toHaveLength(0)
  })

  it.each([
    ['review_panel', 'd', false],
    ['maximize_review_panel', 'd', true],
  ])('routes the View menu item %s through its in-app shortcut', async (command, key, shift) => {
    const events = await captureKeys(async () => {
      await renderBridge()
      listener?.({ payload: command })
    })

    expect(events.map((e) => [e.key, e.ctrlKey, e.metaKey, e.shiftKey])).toEqual([[key, true, false, shift]])
  })

  it.each([
    ['text_size_compact', 'compact'],
    ['text_size_default', 'default'],
    ['text_size_large', 'large'],
  ] as const)('applies the Text Size item %s to the display preferences', async (command, size) => {
    useDisplayPrefsStore.setState({ textSize: size === 'large' ? 'compact' : 'large' })
    await renderBridge()

    listener?.({ payload: command })

    expect(useDisplayPrefsStore.getState().textSize).toBe(size)
  })

  describe('next_needs_you', () => {
    function waiting(ids: string[]) {
      queryClient.setQueryData(queryKeys.session.sessions.active(), {
        pages: [{
          data: ids.map((id) => ({ id, title: id, agent_name: 'lead', created_at: null, updated_at: null, workspace: '/w', running: true, needs_input: true })),
          next_cursor: null,
          has_more: false,
        }],
        pageParams: [null],
      })
    }

    it('opens the first session waiting on the user', async () => {
      waiting(['a', 'b'])
      await renderBridge()

      listener?.({ payload: 'next_needs_you' })

      expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'a' } })
    })

    it('moves on to the next one when the first is already on screen', async () => {
      waiting(['a', 'b'])
      pathname = '/a'
      await renderBridge()

      listener?.({ payload: { command: 'next_needs_you', id: 90 } })

      expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'b' } })
    })

    it('does nothing when no session waits on the user', async () => {
      waiting([])
      await renderBridge()

      listener?.({ payload: 'next_needs_you' })

      expect(navigate).not.toHaveBeenCalled()
    })

    it('picks by the same rule as the unit: skip the open one, else the first', () => {
      const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
      expect(nextNeedsYouSessionId(sessions, null)).toBe('a')
      expect(nextNeedsYouSessionId(sessions, 'a')).toBe('b')
      expect(nextNeedsYouSessionId(sessions, 'c')).toBe('a')
      expect(nextNeedsYouSessionId([{ id: 'a' }], 'a')).toBe('a')
      expect(nextNeedsYouSessionId([], 'a')).toBeNull()
    })
  })

  it('dispatches the same Ctrl+K keyboard event used by the in-app command palette shortcut', async () => {
    const events: KeyboardEvent[] = []
    const onKeyDown = (event: KeyboardEvent) => events.push(event)
    window.addEventListener('keydown', onKeyDown)
    try {
      await renderBridge()

      listener?.({ payload: 'command_palette' })

      expect(events).toHaveLength(1)
      expect(events[0].key).toBe('k')
      expect(events[0].ctrlKey).toBe(true)
      expect(events[0].metaKey).toBe(false)
      expect(events[0].shiftKey).toBe(false)
      expect(events[0].bubbles).toBe(true)
    } finally {
      window.removeEventListener('keydown', onKeyDown)
    }
  })

  it('deduplicates repeated native emits for the same command but allows a different command immediately', async () => {
    const originalNow = Date.now
    const times = [1_000, 1_100, 1_200]
    Date.now = mock(() => times.shift() ?? 1_200) as typeof Date.now
    try {
      const events = await captureKeys(async () => {
        await renderBridge()
        listener?.({ payload: 'quick_open' })
        listener?.({ payload: 'quick_open' })
      })
      expect(events.map((e) => e.key)).toEqual(['p'])

      listener?.({ payload: 'agent_capabilities' })
      expect(useUIStore.getState().runPickerOpen).toBe(true)
    } finally {
      Date.now = originalNow
    }
  })

  it('allows the same command again after the duplicate-suppression window', async () => {
    const originalNow = Date.now
    const times = [2_000, 2_500]
    Date.now = mock(() => times.shift() ?? 2_500) as typeof Date.now
    try {
      const events = await captureKeys(async () => {
        await renderBridge()
        listener?.({ payload: 'quick_open' })
        listener?.({ payload: 'quick_open' })
      })
      expect(events.map((e) => e.key)).toEqual(['p', 'p'])
    } finally {
      Date.now = originalNow
    }
  })

  it('runs each id once, and a new id for the same command right away', async () => {
    const events = await captureKeys(async () => {
      await renderBridge()
      // The shell repeats one command while a new window mounts.
      listener?.({ payload: { command: 'quick_open', id: 41 } })
      listener?.({ payload: { command: 'quick_open', id: 41 } })
      // A second, real press straight after.
      listener?.({ payload: { command: 'quick_open', id: 42 } })
    })
    expect(events.map((e) => e.key)).toEqual(['p', 'p'])
  })

  it("listens for this window's commands only", async () => {
    const win = window as Window & { __OAD_WINDOW_ID__?: string }
    win.__OAD_WINDOW_ID__ = 'main-2'
    try {
      await renderBridge()
      expect(commandListenOptions).toEqual({ target: 'main-2' })
      // A notification click opens its session in one window, not all of them.
      expect(notificationListenOptions).toEqual({ target: 'main-2' })
    } finally {
      delete win.__OAD_WINDOW_ID__
    }
  })

  it('ignores unknown payloads instead of mutating UI state or dispatching shortcuts', async () => {
    let keydownCount = 0
    const onKeyDown = () => { keydownCount += 1 }
    window.addEventListener('keydown', onKeyDown)
    try {
      await renderBridge()

      listener?.({ payload: 'not-a-command' })
      listener?.({ payload: null })

      expect(useUIStore.getState()).toMatchObject({
        schedulerOpen: false,
        runPickerOpen: false,
      })
      expect(keydownCount).toBe(0)
    } finally {
      window.removeEventListener('keydown', onKeyDown)
    }
  })

  it('opens the Settings modal on the Providers tab for settings_providers', async () => {
    const originalOpenSettings = useSettingsStore.getState().openSettings
    const openSettings = mock(() => {})
    useSettingsStore.setState({ openSettings })
    try {
      await renderBridge()

      listener?.({ payload: 'settings_providers' })

      expect(openSettings).toHaveBeenCalledWith('providers')
    } finally {
      useSettingsStore.setState({ openSettings: originalOpenSettings })
    }
  })

  it('unsubscribes from the Tauri event bus when the root unmounts', async () => {
    const view = await renderBridge()

    view.unmount()

    expect(unlistenCalls).toBe(2)
    expect(listener).toBeNull()
    expect(notificationListener).toBeNull()
  })

  it('opens the session of a tapped mobile notification, until the root unmounts', async () => {
    const view = await renderBridge()
    await waitFor(() => expect(tapListener).not.toBeNull())

    tapListener?.('session-9')
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'session-9' } })

    view.unmount()
    expect(tapListener).toBeNull()
  })
})
