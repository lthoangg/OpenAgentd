import { getPlatform } from '@/hooks/use-platform'

export type DesktopNotificationKind = 'assistant_done' | 'background_done' | 'reminder_fired'
export type DesktopNotificationStatus = 'sent' | 'disabled' | 'unsupported' | 'permission-denied' | 'error'

export interface DesktopNotificationPayload {
  kind: DesktopNotificationKind
  title: string
  body: string
}

export interface DesktopNotificationResult {
  status: DesktopNotificationStatus
  message: string
}

const ENABLED_KEY = 'oa-desktop-notifications-enabled'
const SOUND_ENABLED_KEY = 'oa-desktop-notifications-sound-enabled'

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
  try {
    return window.localStorage.getItem(ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ENABLED_KEY, String(enabled))
  } catch {
    // Storage can be unavailable in restricted WebViews/private contexts.
  }
}

export function areDesktopNotificationSoundsEnabled(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(SOUND_ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setDesktopNotificationSoundsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SOUND_ENABLED_KEY, String(enabled))
  } catch {
    // Storage can be unavailable in restricted WebViews/private contexts.
  }
}

function playNotificationSound(): void {
  if (!areDesktopNotificationSoundsEnabled()) return
  const audio = new Audio('/notification.wav')
  audio.play().catch((err: unknown) => {
    console.warn('desktop notification sound failed', err)
  })
}

export function isBackgroundCompletion(toolName: string, result: string | undefined): boolean {
  if (toolName !== 'bg' || !result) return false
  return /PID \d+: (?:exited|stopped)/.test(result)
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
    await invoke('plugin:notification|notify', {
      options: {
        title: payload.title,
        body: payload.body,
        group: `openagentd-${payload.kind}`,
      },
    })
    playNotificationSound()
    return { status: 'sent', message: 'Native notification sent.' }
  } catch (err) {
    console.warn('desktop notification failed', err)
    return {
      status: 'error',
      message: formatNotificationError(err),
    }
  }
}
