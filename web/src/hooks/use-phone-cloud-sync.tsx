import { useEffect, useState } from 'react'

import { getPhoneCloudPending, phoneCloudTakeNotification, type PendingRow } from '@/api/phone-cloud'
import { ApprovalSheet } from '@/components/phone/ApprovalSheet'
import { usePhoneCloudStatus } from '@/queries/phone-cloud'

/**
 * Keeps the phone's account in step while the app runs. Reading the status is
 * enough: once the account is connected (and on every launch while it is),
 * `usePhoneCloudStatus` quietly registers this phone for push.
 *
 * It also answers a tap on "A device wants to join your account" (the push a
 * signer gets when a device signs in): when the app opens or comes back, it
 * asks the shell whether that was tapped, and if so opens the approval sheet
 * for the newest request. The push itself names no device; the sheet reads
 * the requests with signed calls and still needs the 6-digit code.
 */
export function PhoneCloudSync() {
  const status = usePhoneCloudStatus().data
  const signer = status?.state === 'connected' && status.signer
  const [reviewing, setReviewing] = useState<PendingRow | null>(null)

  useEffect(() => {
    if (!signer) return
    let cancelled = false
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      const tapped = await phoneCloudTakeNotification().catch(() => null)
      if (tapped !== 'approval' || cancelled) return
      const rows = await getPhoneCloudPending().catch(() => [] as PendingRow[])
      const newest = rows.reduce<PendingRow | null>((a, b) => (a && (a.created_at ?? 0) >= (b.created_at ?? 0) ? a : b), null)
      if (newest && !cancelled) setReviewing((open) => open ?? newest)
    }
    void check()
    document.addEventListener('visibilitychange', check)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', check)
    }
  }, [signer])

  return reviewing ? <ApprovalSheet row={reviewing} onClose={() => setReviewing(null)} /> : null
}
