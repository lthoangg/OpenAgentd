/**
 * TanStack Query for the phone's account (`api/phone-cloud.ts`).
 *
 * Every hook passes the app's own `queryClient`: the Servers screen shows
 * before the router (and its `QueryClientProvider`) exists, and still needs
 * these. Queries run only in the phone shell; elsewhere they stay idle.
 */
import { useMutation, useQuery } from '@tanstack/react-query'

import {
  getPhoneCloudDevices,
  getPhoneCloudPending,
  isPhoneCloudShell,
  phoneCloudApproveBegin,
  phoneCloudApproveConfirm,
  phoneCloudApproveReject,
  phoneCloudCancel,
  phoneCloudConfirmRecovery,
  phoneCloudRemoveDevice,
  phoneCloudSignIn,
  phoneCloudSignOut,
  type PhoneCloudStatus,
  phoneCloudInviteAdd,
  phoneCloudJoinInvite,
} from '@/api/phone-cloud'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from './keys'

export {
  PHONE_CLOUD_POLL_MS,
  phoneCloudPollInterval,
  resetPhoneCloudPush,
  usePhoneCloudStatus,
} from './phone-cloud-status'

/** How often pending approvals refetch while the Account screen shows a signer. */
export const PHONE_CLOUD_PENDING_POLL_MS = 5000

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
  useStatusMutation(({ enrollmentId, approver }: { enrollmentId: string; approver: boolean }) =>
    phoneCloudApproveConfirm(enrollmentId, approver))

export const usePhoneApproveBegin = () =>
  useMutation({ mutationFn: (enrollmentId: string) => phoneCloudApproveBegin(enrollmentId) }, queryClient)

export const usePhoneApproveReject = () =>
  useMutation({
    mutationFn: (enrollmentId: string) => phoneCloudApproveReject(enrollmentId),
    onSuccess: refreshLists,
  }, queryClient)

export const usePhoneJoinInvite = () => useStatusMutation((link: string) => phoneCloudJoinInvite(link))
export const usePhoneInviteAdd = () => useStatusMutation((enrollmentId: string) => phoneCloudInviteAdd(enrollmentId))
