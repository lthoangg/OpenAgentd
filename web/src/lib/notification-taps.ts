/**
 * What a tapped notification opens: a session, on the server it came from.
 *
 * A phone shows notifications from several places: its own (raised from the
 * server it is on, while the app runs) and the account's pushes (from any
 * computer of the account). Either can be tapped after the app switched
 * servers, or after iOS ended the page or the app, so:
 * - the app remembers, per notification it posts, the session and the
 *   server it was on, in storage that outlives the page;
 * - the shell queues every tap until the page asks
 *   (`notification_take_taps`, `mobile/src-tauri/src/taps.rs`), because a tap
 *   that launches the app comes before the page can listen.
 */
import { getPlatform } from '@/hooks/use-platform'
import { getAppBackendStatus } from '@/lib/app-backend'

/** Where a tap goes. With neither server field, the server in use. */
export interface NotificationTarget {
  sessionId: string
  /** The server's origin when the notification was raised (LAN or saved server). */
  baseUrl?: string
  /** The account computer it came from: a push's sender, or the bridge the app was on. */
  deviceId?: string
}

/** A tap the shell queued (see `taps.rs`). */
export type NativeTap =
  | { kind: 'approval' }
  | { kind: 'session'; session: string; sender?: string }
  | { kind: 'local'; id: number }

const STORAGE_KEY = 'oa-notification-taps'
/** Notifications remembered; the oldest goes first. */
export const MAX_REMEMBERED_TAPS = 50

type Remembered = [number, NotificationTarget][]

function isTarget(value: unknown): value is NotificationTarget {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return typeof t.sessionId === 'string' && t.sessionId.length > 0
    && (t.baseUrl === undefined || typeof t.baseUrl === 'string')
    && (t.deviceId === undefined || typeof t.deviceId === 'string')
}

function readRemembered(): Remembered {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is [number, NotificationTarget] =>
      Array.isArray(entry) && typeof entry[0] === 'number' && isTarget(entry[1]))
  } catch {
    return []
  }
}

/** Remember what the notification with this id opens. */
export function rememberNotificationTarget(id: number, target: NotificationTarget): void {
  const entries = readRemembered().filter(([known]) => known !== id)
  entries.push([id, target])
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_REMEMBERED_TAPS)))
  } catch {
    // Storage full or blocked: the tap then opens the app as it is.
  }
}

/** What the app's notification with this id opens, if it was remembered. */
export function notificationTarget(id: number): NotificationTarget | null {
  return readRemembered().find(([known]) => known === id)?.[1] ?? null
}

/** What a queued tap opens: the approval sheet, a session, or nothing. */
export function tapTarget(tap: NativeTap): NotificationTarget | 'approval' | null {
  if (tap.kind === 'approval') return 'approval'
  if (tap.kind === 'session') return tap.sender ? { sessionId: tap.session, deviceId: tap.sender } : { sessionId: tap.session }
  return notificationTarget(tap.id)
}

function isNativeTap(value: unknown): value is NativeTap {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  if (t.kind === 'approval') return true
  if (t.kind === 'session') return typeof t.session === 'string' && (t.sender === undefined || typeof t.sender === 'string')
  return t.kind === 'local' && typeof t.id === 'number'
}

function isPhoneShell(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

/** The taps the shell queued since the last call, oldest first; [] off the phone. */
export async function takeNativeTaps(): Promise<NativeTap[]> {
  if (!isPhoneShell()) return []
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const taps: unknown = await invoke('notification_take_taps')
    return Array.isArray(taps) ? taps.filter(isNativeTap) : []
  } catch {
    // An older shell without the command.
    return []
  }
}

/** The server this app is on now, as a notification remembers it. */
export async function currentServerRef(): Promise<Pick<NotificationTarget, 'baseUrl' | 'deviceId'>> {
  try {
    const status = await getAppBackendStatus()
    if (!status?.base_url) return {}
    const baseUrl = status.base_url.trim().replace(/\/+$/, '').replace(/\/api$/i, '')
    const deviceId = status.account_device?.device_id
    return deviceId ? { baseUrl, deviceId } : { baseUrl }
  } catch {
    return {}
  }
}
