import { useEffect, useReducer } from 'react'

import { getPhoneCloudPending, type PendingRow } from '@/api/phone-cloud'
import { ApprovalSheet } from '@/components/phone/ApprovalSheet'
import { NO_TAP, approvalTapStep } from '@/hooks/approval-tap-state'
import { listenForNotificationTaps } from '@/lib/desktop-notifications'
import type { NotificationTarget } from '@/lib/notification-taps'
import { openSessionOnServer } from '@/lib/open-on-server'
import { usePhoneCloudStatus } from '@/queries/phone-cloud'

/** The same notification reported twice within this long opens once. */
const SAME_TAP_MS = 3_000

/**
 * Keeps the phone's account in step while the app runs, and answers taps on
 * notifications. Mounted before a server is up too, so a tap that launched
 * the app can still reach another computer.
 *
 * Reading the status is enough for the account: once it is connected (and on
 * every launch while it is), `usePhoneCloudStatus` quietly registers this
 * phone for push.
 *
 * Taps come from the shell's queue (`takeNativeTaps`), read at launch, when
 * the app comes back, and when the shell says one arrived; and, on Android
 * while the app runs, from the notification plugin.
 * - "A device wants to join your account" opens the approval sheet for the
 *   newest request (signers only). The push names no device; the sheet reads
 *   the requests with signed calls and still needs the 6-digit code.
 * - Done / Needs you / Failed opens that session on the computer or server
 *   it came from, switching to it first when needed.
 */
export function PhoneCloudSync() {
  const status = usePhoneCloudStatus().data
  const statusKnown = status !== undefined
  const signer = status?.state === 'connected' && status.signer
  // The approval sheet a tap opens (``approval-tap-state.ts``).
  const [approvalTap, sendTap] = useReducer(approvalTapStep, NO_TAP)
  const approvalTapped = approvalTap.kind === 'tapped'

  useEffect(() => {
    let cancelled = false
    let last: { key: string; at: number } | null = null
    const open = (target: NotificationTarget) => {
      const key = JSON.stringify([target.sessionId, target.deviceId ?? '', target.baseUrl ?? ''])
      const now = Date.now()
      if (last && last.key === key && now - last.at < SAME_TAP_MS) return
      last = { key, at: now }
      void openSessionOnServer(target)
    }
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      // Loaded here, not at startup: the tap queue is read only on the phone.
      const { takeNativeTaps, tapTarget } = await import('@/lib/notification-taps')
      const taps = await takeNativeTaps()
      if (cancelled) return
      // Only the newest session tap: older ones were superseded by it.
      let session: NotificationTarget | null = null
      for (const tap of taps) {
        const target = tapTarget(tap)
        if (target === 'approval') sendTap({ type: 'tap' })
        else if (target) session = target
      }
      if (session) open(session)
    }
    void check()
    document.addEventListener('visibilitychange', check)
    let stopEvent: (() => void) | undefined
    let stopPlugin: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('notification-tapped', () => { void check() }))
      .then((stop) => { if (cancelled) stop(); else stopEvent = stop })
      .catch(() => {})
    void listenForNotificationTaps(open)
      .then((stop) => { if (cancelled) stop(); else stopPlugin = stop })
      .catch(() => {})
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', check)
      stopEvent?.()
      stopPlugin?.()
    }
  }, [])

  useEffect(() => {
    if (!approvalTapped) return
    // A tap that launched the app waits for the first status read. Once the
    // status is known and this phone cannot approve, the tap is dropped:
    // kept, it would open the sheet by itself after a later sign-in.
    if (!statusKnown) return
    if (!signer) {
      sendTap({ type: 'drop' })
      return
    }
    let cancelled = false
    void getPhoneCloudPending()
      .catch(() => [] as PendingRow[])
      .then((rows) => {
        if (cancelled) return
        const newest = rows.reduce<PendingRow | null>((a, b) => (a && (a.created_at ?? 0) >= (b.created_at ?? 0) ? a : b), null)
        sendTap(newest ? { type: 'found', row: newest } : { type: 'drop' })
      })
    return () => {
      cancelled = true
    }
  }, [statusKnown, signer, approvalTapped])

  return approvalTap.kind === 'reviewing' ? <ApprovalSheet row={approvalTap.row} onClose={() => sendTap({ type: 'close' })} /> : null
}
