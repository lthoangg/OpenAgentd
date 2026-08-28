import { afterEach, describe, expect, it, mock } from 'bun:test'
import { render, waitFor } from '@testing-library/react'

import { router } from '@/router'
import { useDesktopCommands } from '@/lib/desktop-commands'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

let listener: ((event: { payload: unknown }) => void) | null = null
let notificationListener: ((event: { payload: unknown }) => void) | null = null
let unlistenCalls = 0

mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: (event: { payload: unknown }) => void) => {
    if (event === 'desktop-command') listener = cb
    else notificationListener = cb
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
    agentCapabilitiesOpen: false,
    paletteOpen: false,
  })
  listener = null
  notificationListener = null
  unlistenCalls = 0
}

afterEach(resetUIStore)

describe('useDesktopCommands', () => {
  it('routes panel commands through the shared UI store and keeps panels mutually exclusive', async () => {
    await renderBridge()

    listener?.({ payload: 'scheduler' })
    expect(useUIStore.getState()).toMatchObject({
      schedulerOpen: true,
      agentCapabilitiesOpen: false,
    })

    listener?.({ payload: 'agent_capabilities' })
    expect(useUIStore.getState()).toMatchObject({
      schedulerOpen: false,
      agentCapabilitiesOpen: true,
    })
  })

  it('dispatches the same Ctrl+Shift+P keyboard event used by the in-app command palette shortcut', async () => {
    const events: KeyboardEvent[] = []
    const onKeyDown = (event: KeyboardEvent) => events.push(event)
    window.addEventListener('keydown', onKeyDown)
    try {
      await renderBridge()

      listener?.({ payload: 'command_palette' })

      expect(events).toHaveLength(1)
      expect(events[0].key).toBe('p')
      expect(events[0].ctrlKey).toBe(true)
      expect(events[0].metaKey).toBe(false)
      expect(events[0].shiftKey).toBe(true)
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
      await renderBridge()

      listener?.({ payload: 'scheduler' })
      listener?.({ payload: 'scheduler' })
      expect(useUIStore.getState().schedulerOpen).toBe(true)

      listener?.({ payload: 'agent_capabilities' })
      expect(useUIStore.getState()).toMatchObject({
        schedulerOpen: false,
        agentCapabilitiesOpen: true,
      })
    } finally {
      Date.now = originalNow
    }
  })

  it('allows the same command again after the duplicate-suppression window', async () => {
    const originalNow = Date.now
    const times = [2_000, 2_500]
    Date.now = mock(() => times.shift() ?? 2_500) as typeof Date.now
    try {
      await renderBridge()

      listener?.({ payload: 'scheduler' })
      expect(useUIStore.getState().schedulerOpen).toBe(true)

      listener?.({ payload: 'scheduler' })
      expect(useUIStore.getState().schedulerOpen).toBe(false)
    } finally {
      Date.now = originalNow
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
        agentCapabilitiesOpen: false,
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

  it('navigates to /coding when the coding command is emitted', async () => {
    const originalNavigate = router.navigate
    const navigate = mock(async () => {})
    router.navigate = navigate as typeof router.navigate
    try {
      await renderBridge()

      listener?.({ payload: 'coding' })

      expect(navigate).toHaveBeenCalledWith({ to: '/coding' })
    } finally {
      router.navigate = originalNavigate
    }
  })

  it('unsubscribes from the Tauri event bus when the root unmounts', async () => {
    const view = await renderBridge()

    view.unmount()

    expect(unlistenCalls).toBe(2)
    expect(listener).toBeNull()
    expect(notificationListener).toBeNull()
  })
})
