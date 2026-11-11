/**
 * TanStack Query for the phone's account (`api/phone-cloud.ts`).
 *
 * Every hook passes the app's own `queryClient`: the Servers screen shows
 * before the router (and its `QueryClientProvider`) exists, and still needs
 * these. Queries run only in the phone shell; elsewhere they stay idle.
 */
import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import {
  getPhoneCloudDevices,
  getPhoneCloudPending,
  getPhoneCloudStatus,
  isPhoneCloudShell,
  phoneCloudApproveBegin,
  phoneCloudApproveConfirm,
  phoneCloudApproveReject,
  phoneCloudCancel,
  phoneCloudConfirmRecovery,
  phoneCloudPushRegister,
  phoneCloudRemoveDevice,
  phoneCloudSignIn,
  phoneCloudSignOut,
  type PhoneCloudStatus,
  phoneCloudInviteAdd,
  phoneCloudJoinInvite,
} from '@/api/phone-cloud'
import type { Roles } from '@/api/cloud'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from './keys'

/** How often the status refetches while something waits on the user. */
export const PHONE_CLOUD_POLL_MS = 2000
/** How often pending approvals refetch while the Account screen shows a signer. */
export const PHONE_CLOUD_PENDING_POLL_MS = 5000

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
/** A registration in flight, so a resume during it does not send another. */
let registering: string | null = null

/**
 * Hand this phone's push token to the account once per launch. Only a call
 * that really registered counts: with notifications not allowed yet (or no
 * token from APNs) it tries again when the app comes back or notifications
 * get allowed, instead of waiting for the next launch.
 */
function registerPushOnce(fingerprint: string | null) {
  if (!fingerprint) {
    pushedFor = null
    return
  }
  if (pushedFor === fingerprint || registering === fingerprint) return
  registering = fingerprint
  // Quiet by design: push is a bonus, and a guest never sees this.
  void phoneCloudPushRegister(fingerprint)
    .then((registered) => { if (registered) pushedFor = fingerprint })
    .catch(() => undefined)
    .finally(() => { if (registering === fingerprint) registering = null })
}

/** Fired by the notification setup when the person allows notifications. */
export const NOTIFICATIONS_ALLOWED_EVENT = 'openagentd:notifications-allowed'

/** Test seam. */
export function resetPhoneCloudPush(): void {
  pushedFor = null
  registering = null
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
    if (!known) return
    registerPushOnce(fingerprint)
    if (!fingerprint) return
    // Not registered yet (notifications not allowed, no token): try again
    // when the app comes back, or right after notifications are allowed.
    const retry = () => { if (document.visibilityState === 'visible') registerPushOnce(fingerprint) }
    document.addEventListener('visibilitychange', retry)
    window.addEventListener(NOTIFICATIONS_ALLOWED_EVENT, retry)
    return () => {
      document.removeEventListener('visibilitychange', retry)
      window.removeEventListener(NOTIFICATIONS_ALLOWED_EVENT, retry)
    }
  }, [known, fingerprint])
  return query
}

export function usePhoneCloudDevices(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.phoneCloud.devices(),
    queryFn: getPhoneCloudDevices,
    enabled: enabled && isPhoneCloudShell(),
    staleTime: 0,
  }, queryClient)
}

export function usePhoneCloudPending(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.phoneCloud.pending(),
    queryFn: getPhoneCloudPending,
    enabled: enabled && isPhoneCloudShell(),
    staleTime: 0,
    refetchInterval: PHONE_CLOUD_PENDING_POLL_MS,
  }, queryClient)
}

function refreshLists() {
  void queryClient.invalidateQueries({ queryKey: queryKeys.phoneCloud.devices() })
  void queryClient.invalidateQueries({ queryKey: queryKeys.phoneCloud.pending() })
}

/** A command that answers with the new status: it becomes the query's data. */
function useStatusMutation<V = void>(mutationFn: (variables: V) => Promise<PhoneCloudStatus>) {
  return useMutation({
    mutationFn,
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.phoneCloud.status(), status)
      refreshLists()
    },
  }, queryClient)
}

export const usePhoneSignIn = () => useStatusMutation(phoneCloudSignIn)
export const usePhoneCancel = () => useStatusMutation(phoneCloudCancel)
export const usePhoneSignOut = () => useStatusMutation(phoneCloudSignOut)
export const usePhoneRemoveDevice = () => useStatusMutation((deviceId: string) => phoneCloudRemoveDevice(deviceId))
export const usePhoneConfirmRecovery = () =>
  useStatusMutation(({ first, second }: { first: string; second: string }) => phoneCloudConfirmRecovery(first, second))
export const usePhoneApproveConfirm = () =>
  useStatusMutation(({ enrollmentId, approver, roles }: { enrollmentId: string; approver: boolean; roles: Roles }) =>
    phoneCloudApproveConfirm(enrollmentId, approver, roles))

export const usePhoneApproveBegin = () =>
  useMutation({ mutationFn: (enrollmentId: string) => phoneCloudApproveBegin(enrollmentId) }, queryClient)

export const usePhoneApproveReject = () =>
  useMutation({
    mutationFn: (enrollmentId: string) => phoneCloudApproveReject(enrollmentId),
    onSuccess: refreshLists,
  }, queryClient)

export const usePhoneJoinInvite = () => useStatusMutation((link: string) => phoneCloudJoinInvite(link))
export const usePhoneInviteAdd = () => useStatusMutation((enrollmentId: string) => phoneCloudInviteAdd(enrollmentId))
