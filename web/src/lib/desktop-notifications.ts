import { getPlatform } from '@/hooks/use-platform'
import { currentServerRef, notificationTarget, rememberNotificationTarget, type NotificationTarget } from '@/lib/notification-taps'

/**
 * ``input_needed`` — the lead is suspended on ``ask_user`` and cannot
 * continue until the user answers. Unlike the others it is sent with
 * ``force: true`` when the asking session is not the one on screen, so a
 * blocked agent is not silently waiting behind a focused window.
 * ``device_approval`` — a device signed in to the account and waits for this
 * computer (a signer) to approve it; its text is fixed and names no device.
 */
export type DesktopNotificationKind = 'assistant_done' | 'reminder_fired' | 'input_needed' | 'device_approval'
export type DesktopNotificationStatus = 'sent' | 'disabled' | 'unsupported' | 'permission-denied' | 'error'

export interface DesktopNotificationPayload {
  kind: DesktopNotificationKind
  /** Backend event id; the desktop shell shows each id once across windows. */
  notificationId?: string
  sessionId?: string
  title: string
  body: string
}

export interface DesktopNotificationResult {
  status: DesktopNotificationStatus
  message: string
}

const ENABLED_KEY = 'oa-desktop-notifications-enabled'
let permissionRequested = false

/**
 * Kinds a computer also sends to its account's phones as an APNs push
 * (``appv3/crates/api/src/cloud/letters.rs``). On such an iPhone the push
 * covers the app in the background and iOS hides it while the app is open,
 * so the app shows these itself only while it is open.
 */
const PUSHED_KINDS: ReadonlySet<DesktopNotificationKind> = new Set(['assistant_done', 'input_needed'])
/**
 * Events the app handles in its first moments back on screen were raised
 * while it was in the background (iOS delivers them on resume), and the push
 * already showed them.
 */
const RESUME_GRACE_MS = 3000
/** When the page last came on screen; 0 at launch, which holds no earlier events. */
let visibleSince = 0
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') visibleSince = Date.now()
  })
}

export interface DesktopNotificationOptions {
  /** Skip the window-focus check; the user's notification setting still applies. */
  force?: boolean
  /** The notification is about the session on screen; mobile skips it while visible. */
  sessionOnScreen?: boolean
  /**
   * Raised while the app was away and replayed when it reconnected. On an
   * iPhone with the account's push, the push already showed it.
   */
  replayed?: boolean
}

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

function appOpenOnScreen(): boolean {
  return document.visibilityState === 'visible' && Date.now() - visibleSince >= RESUME_GRACE_MS
}

/**
 * Whether this phone gets the account's pushes: signed in as a signer (the
 * devices a computer sends them to) and registered for push this launch
 * (notifications allowed, token handed to the account). Unknown counts as
 * no, so a failure can repeat a notification but never lose one.
 */
async function phoneReceivesPush(): Promise<boolean> {
  try {
    const { getPhoneCloudStatus, phonePushRegistered } = await import('@/api/phone-cloud')
    const status = await getPhoneCloudStatus()
    return status.state === 'connected' && status.signer && phonePushRegistered(status.fingerprint)
  } catch {
    return false
  }
}

export function areDesktopNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return true
  return window.localStorage.getItem(ENABLED_KEY) !== 'false'
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ENABLED_KEY, String(enabled))
}

async function shouldNotify(
  kind: DesktopNotificationKind,
  options: DesktopNotificationOptions = {},
): Promise<DesktopNotificationResult | null> {
  if (!isTauriRuntime()) {
    return { status: 'unsupported', message: 'Native app notifications only work in the Tauri app.' }
  }
  if (!areDesktopNotificationsEnabled()) {
    return { status: 'disabled', message: 'App notifications are disabled.' }
  }
  // Before ``force``: a question would otherwise arrive twice, once from here
  // and once as the push.
  if (getPlatform().os === 'ios' && PUSHED_KINDS.has(kind) && (options.replayed || !appOpenOnScreen()) && (await phoneReceivesPush())) {
    return { status: 'disabled', message: 'The account push shows this while the app is in the background.' }
  }
  if (options.force) return null
  if (isMobileTauriRuntime()) {
    // iOS pauses a backgrounded app's JavaScript, so most mobile notifications
    // are sent while the app is open. Skip only the one repeating the screen.
    return options.sessionOnScreen && document.visibilityState === 'visible'
      ? { status: 'disabled', message: 'Mobile notifications are skipped for the session on screen.' }
      : null
  }

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

/**
 * Plugin options for a mobile notification. The session it opens, and the
 * server the app is on, are remembered by its id in storage that outlives
 * the page (`notification-taps.ts`): a tap can come after a relaunch or a
 * server switch, and the plugin reports only the id.
 */
async function mobileNotificationOptions(payload: DesktopNotificationPayload) {
  // Random rather than counted: iOS replaces a delivered notification that
  // reuses an identifier, and a counter would restart at every launch.
  const id = 1 + Math.floor(Math.random() * 0x7ffffffe)
  if (payload.sessionId) rememberNotificationTarget(id, { sessionId: payload.sessionId, ...(await currentServerRef()) })
  return { id, title: payload.title, body: payload.body, group: `openagentd-${payload.kind}` }
}

export async function sendDesktopNotification(
  payload: DesktopNotificationPayload,
  options: DesktopNotificationOptions = {},
): Promise<DesktopNotificationResult> {
  const skipped = await shouldNotify(payload.kind, options)
  if (skipped) return skipped

  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
    let granted = await isPermissionGranted()
    if (!granted && !permissionRequested) {
      permissionRequested = true
      granted = (await requestPermission()) === 'granted'
      // Push needs the same permission: the account can register now.
      if (granted && typeof window !== 'undefined') window.dispatchEvent(new Event('openagentd:notifications-allowed'))
    }
    if (!granted) {
      return { status: 'permission-denied', message: 'OS notification permission was not granted.' }
    }
    const { invoke } = await import('@tauri-apps/api/core')
    if (isMobileTauriRuntime()) {
      // show_desktop_notification exists only in the desktop shell.
      await invoke('plugin:notification|notify', { options: await mobileNotificationOptions(payload) })
    } else {
      const shown = await invoke<boolean | null>('show_desktop_notification', {
        payload: {
          kind: payload.kind,
          ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
          title: payload.title,
          body: payload.body,
        },
      })
      // Every window gets the event; the shell shows it from one of them.
      if (shown === false) {
        return { status: 'disabled', message: 'Another app window showed or suppressed this notification.' }
      }
    }
    return { status: 'sent', message: 'Native notification sent.' }
  } catch (err) {
    console.warn('desktop notification failed', err)
    return {
      status: 'error',
      message: formatNotificationError(err),
    }
  }
}

/**
 * Call ``onTarget`` with what a tapped Android notification opens, while the
 * app runs. Desktop clicks arrive from the shell as
 * ``desktop-notification-clicked``; iOS taps, and the Android tap that
 * launched the app, come from the shell's queue (``takeNativeTaps``).
 * Resolves to an unsubscribe.
 */
export async function listenForNotificationTaps(onTarget: (target: NotificationTarget) => void): Promise<() => void> {
  if (!isMobileTauriRuntime() || getPlatform().os !== 'android') return () => {}
  const { onAction } = await import('@tauri-apps/plugin-notification')
  const listener = await onAction((event) => {
    // Typed upstream as the send options; the plugin sends { actionId, notification: { id, ... } }.
    const { actionId, notification } = event as unknown as { actionId?: unknown; notification?: { id?: unknown } }
    if (actionId !== 'tap' || typeof notification?.id !== 'number') return
    const target = notificationTarget(notification.id)
    if (target) onTarget(target)
  })
  return () => {
    void listener.unregister()
  }
}
