/**
 * The phone account's status query: the part of `queries/phone-cloud.ts`
 * the startup path needs (Settings sections, LAN fingerprints). The other
 * hooks load with the account screens.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import { getPhoneCloudStatus, isPhoneCloudShell, phoneCloudPushRegister, type PhoneCloudStatus } from '@/api/phone-cloud-core'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from './keys'

/** How often the status refetches while something waits on the user. */
export const PHONE_CLOUD_POLL_MS = 2000

/**
 * Poll only while a sign-in, a join or the recovery step is under way;
 * otherwise the status refetches on mount and window focus alone.
 */
export function phoneCloudPollInterval(status: PhoneCloudStatus | undefined): number | false {
  const state = status?.state
  return state === 'signing_in' || state === 'joining' || state === 'invited' || state === 'recovery' ? PHONE_CLOUD_POLL_MS : false
}

/** The fingerprint whose push token this launch already handed to the account. */
let pushedFor: string | null = null

function registerPushOnce(fingerprint: string | null) {
  if (!fingerprint) {
    pushedFor = null
    return
  }
  if (pushedFor === fingerprint) return
  pushedFor = fingerprint
  // Quiet by design: push is a bonus, and a guest never sees this.
  void phoneCloudPushRegister().catch(() => undefined)
}

/** Test seam. */
export function resetPhoneCloudPush(): void {
  pushedFor = null
}

export function usePhoneCloudStatus() {
  const query = useQuery({
    queryKey: queryKeys.phoneCloud.status(),
    queryFn: getPhoneCloudStatus,
    enabled: isPhoneCloudShell(),
    staleTime: 0,
    refetchInterval: (q) => phoneCloudPollInterval(q.state.data),
  }, queryClient)
  const data = query.data
  const fingerprint = data?.state === 'connected' ? data.fingerprint : null
  const known = data !== undefined
  // Once connected (and again on each launch), the phone registers for push.
  useEffect(() => {
    if (known) registerPushOnce(fingerprint)
  }, [known, fingerprint])
  return query
}
