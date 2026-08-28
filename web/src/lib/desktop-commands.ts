/**
 * Native desktop command bridge.
 *
 * Tauri menu/tray items live in Rust, while panel state and the command
 * palette live in React/Zustand. Rust emits a small string command and this
 * bridge fans it back into the same keyboard events the web UI already uses.
 */
import { useEffect } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { getPlatform } from '@/hooks/use-platform'
import { dispatchShortcutKey } from '@/lib/keyboard-shortcut'
import { router } from '@/router'

interface NotificationClickPayload {
  sessionId?: unknown
  mode?: unknown
}

function runDesktopCommand(command: unknown): void {
  switch (command) {
    case 'coding':
      void router.navigate({ to: '/coding' })
      break
    case 'quick_open':
      dispatchShortcutKey('p', getPlatform().os)
      break
    case 'command_palette':
      dispatchShortcutKey('p', getPlatform().os, { shift: true })
      break
    case 'scheduler':
      useUIStore.getState().toggleScheduler()
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

export function openNotificationSession(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const notification = payload as NotificationClickPayload
  if (typeof notification.sessionId !== 'string') return
  const to = '/coding/$sessionId'
  void router.navigate({ to, params: { sessionId: notification.sessionId } })
}

let lastCommand: { command: unknown; timestamp: number } | null = null

export function useDesktopCommands(): void {
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false

    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<unknown>('desktop-command', (event) => {
          const now = Date.now()
          if (lastCommand && lastCommand.command === event.payload && now - lastCommand.timestamp < 450) return
          lastCommand = { command: event.payload, timestamp: now }
          runDesktopCommand(event.payload)
        })
        const unlistenNotification = await listen<NotificationClickPayload>('desktop-notification-clicked', (event) => {
          openNotificationSession(event.payload)
        })
        if (cancelled) {
          unlisten()
          unlistenNotification()
          return
        }
        cleanup = () => {
          unlisten()
          unlistenNotification()
        }
      } catch {
        // Browser build: no Tauri event bus.
      }
    })()

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])
}
