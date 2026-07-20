import { getPlatform } from '@/hooks/use-platform'

export type DesktopNotificationKind = 'assistant_done' | 'reminder_fired'
export type DesktopNotificationStatus = 'sent' | 'disabled' | 'unsupported' | 'permission-denied' | 'error'

export interface DesktopNotificationPayload {
  kind: DesktopNotificationKind
  sessionId?: string
  mode?: 'normal' | 'coding'
  title: string
  body: string
}

export interface DesktopNotificationResult {
  status: DesktopNotificationStatus
  message: string
}

const ENABLED_KEY = 'oa-desktop-notifications-enabled'
let permissionRequested = false

function formatNotificationError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    const serialized = JSON.stringify(err)
    return serialized && serialized !== '{}' ? serialized : 'Native notification failed.'
  } catch {
    return String(err || 'Native notification failed.')
  }
}

function isTauriRuntime(): boolean {
  return getPlatform().isTauri
}

function isMobileTauriRuntime(): boolean {
  const platform = getPlatform()
  return platform.isTauri && (platform.os === 'ios' || platform.os === 'android')
}

export function areDesktopNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return true
  return window.localStorage.getItem(ENABLED_KEY) !== 'false'
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ENABLED_KEY, String(enabled))
}

async function shouldNotify(options: { force?: boolean } = {}): Promise<DesktopNotificationResult | null> {
  if (!isTauriRuntime()) {
    return { status: 'unsupported', message: 'Native app notifications only work in the Tauri app.' }
  }
  if (!areDesktopNotificationsEnabled()) {
    return { status: 'disabled', message: 'App notifications are disabled.' }
  }
  if (options.force) return null
  if (isMobileTauriRuntime()) return null

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const appWindow = getCurrentWindow()
    const [focused, visible, minimized] = await Promise.all([
      appWindow.isFocused(),
      appWindow.isVisible(),
      appWindow.isMinimized(),
    ])
    return !focused || !visible || minimized
      ? null
      : { status: 'disabled', message: 'Desktop notifications are skipped while the app window is focused.' }
  } catch (err) {
    console.warn('desktop notification focus check failed', err)
    return { status: 'error', message: 'Could not check app window focus state.' }
  }
}

export async function sendDesktopNotification(
  payload: DesktopNotificationPayload,
  options: { force?: boolean } = {},
): Promise<DesktopNotificationResult> {
  const skipped = await shouldNotify(options)
  if (skipped) return skipped

  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
    let granted = await isPermissionGranted()
    if (!granted && !permissionRequested) {
      permissionRequested = true
      granted = (await requestPermission()) === 'granted'
    }
    if (!granted) {
      return { status: 'permission-denied', message: 'OS notification permission was not granted.' }
    }
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('show_desktop_notification', {
      payload: {
        kind: payload.kind,
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        ...(payload.mode ? { mode: payload.mode } : {}),
        title: payload.title,
        body: payload.body,
      },
    })
    return { status: 'sent', message: 'Native notification sent.' }
  } catch (err) {
    console.warn('desktop notification failed', err)
    return {
      status: 'error',
      message: formatNotificationError(err),
    }
  }
}
