/**
 * Native desktop command bridge.
 *
 * Tauri menu/tray items live in Rust, while panel state and the command
 * palette live in React/Zustand. Rust emits a small string command and this
 * bridge fans it back into the same keyboard events the web UI already uses,
 * or into an app event for actions that have no shortcut.
 */
import { useEffect } from 'react'
import { useRouter, type AnyRouter } from '@tanstack/react-router'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { getPlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, dispatchAppShortcut } from '@/lib/app-shortcuts'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { listenForNotificationTaps } from '@/lib/desktop-notifications'
import { desktopWindowId } from '@/lib/desktop-window-identity'

interface NotificationClickPayload {
  sessionId?: unknown
  mode?: unknown
}

function runDesktopCommand(command: unknown): void {
  switch (command) {
    case 'new_session':
      dispatchAppShortcut(APP_SHORTCUTS.newSession, getPlatform().os)
      break
    case 'open_workspace':
      dispatchAppEvent(APP_EVENTS.openWorkspace)
      break
    case 'toggle_sidebar':
      dispatchAppShortcut(APP_SHORTCUTS.sidebar, getPlatform().os)
      break
    case 'terminal':
      dispatchAppEvent(APP_EVENTS.openTerminal)
      break
    case 'quick_open':
      dispatchAppShortcut(APP_SHORTCUTS.quickOpen, getPlatform().os)
      break
    case 'command_palette':
      dispatchAppShortcut(APP_SHORTCUTS.commandPalette, getPlatform().os)
      break
    case 'scheduler':
      // The chat shell decides: dock tab with a workspace, overlay otherwise.
      dispatchAppEvent(APP_EVENTS.toggleScheduler)
      break
    case 'agent_capabilities':
      useUIStore.getState().toggleAgentCapabilities()
      break
    case 'settings':
      useSettingsStore.getState().openSettings()
      break
    case 'settings_providers':
      useSettingsStore.getState().openSettings('providers')
      break
  }
}

export function openNotificationSession(payload: unknown, router: AnyRouter): void {
  if (!payload || typeof payload !== 'object') return
  const notification = payload as NotificationClickPayload
  if (typeof notification.sessionId !== 'string') return
  const to = '/$sessionId'
  void router.navigate({ to, params: { sessionId: notification.sessionId } })
}

/**
 * The shell repeats each command a few times while a just-created window
 * mounts this listener. Commands carry an id, so each id runs once and a
 * real second press right after still runs. Bare string payloads (older
 * shells) fall back to dropping repeats within 450 ms.
 */
let lastCommand: { command: unknown; timestamp: number } | null = null
const seenIds: number[] = []

function acceptCommand(payload: unknown): unknown {
  if (payload && typeof payload === 'object') {
    const { command, id } = payload as { command?: unknown; id?: unknown }
    if (typeof command !== 'string' || typeof id !== 'number') return null
    if (seenIds.includes(id)) return null
    seenIds.push(id)
    if (seenIds.length > 32) seenIds.shift()
    return command
  }
  const now = Date.now()
  if (lastCommand && lastCommand.command === payload && now - lastCommand.timestamp < 450) return null
  lastCommand = { command: payload, timestamp: now }
  return payload
}

export function useDesktopCommands(): void {
  // From context, not the `@/router` singleton: importing that here closes
  // router.ts -> routes/__root.tsx -> this module -> router.ts.
  const router = useRouter()
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false

    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        // Commands are sent to one window; a global listener would also
        // receive the ones meant for the other windows.
        const windowId = desktopWindowId()
        const unlisten = await listen<unknown>('desktop-command', (event) => {
          const command = acceptCommand(event.payload)
          if (command !== null) runDesktopCommand(command)
        }, windowId ? { target: windowId } : undefined)
        // The shell sends a click to the one window it brings forward.
        const unlistenNotification = await listen<NotificationClickPayload>('desktop-notification-clicked', (event) => {
          openNotificationSession(event.payload, router)
        }, windowId ? { target: windowId } : undefined)
        // The mobile shell reports taps through the notification plugin instead.
        const stopTaps = await listenForNotificationTaps((sessionId) => {
          openNotificationSession({ sessionId }, router)
        })
        if (cancelled) {
          unlisten()
          unlistenNotification()
          stopTaps()
          return
        }
        cleanup = () => {
          unlisten()
          unlistenNotification()
          stopTaps()
        }
      } catch {
        // Browser build: no Tauri event bus.
      }
    })()

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [router])
}
