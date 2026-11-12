import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  APPROVE_ELSEWHERE,
  REMOVE_ELSEWHERE,
  cloudApproveBegin,
  cloudApproveConfirm,
  cloudApproveReject,
  cloudConfirmRecovery,
  cloudJoin,
  cloudLogin,
  cloudLoginCancel,
  cloudLogout,
  cloudRemoveDevice,
  getCloudDevices,
  getCloudPending,
  getCloudStatus,
  type CloudStatus,
  type Roles,
} from '@/api/cloud'
import { approvalProof, canApproveHere } from '@/lib/approval-proof'
import { cloudPollInterval } from './cloud-light'
import { queryKeys } from './keys'

export { CLOUD_POLL_MS, cloudPollInterval, useDesktopCloudDevices, useDesktopCloudStatus } from './cloud-light'
/** How often a signer asks for pending requests (the desktop notifies on a new one). */
export const CLOUD_PENDING_POLL_MS = 30_000

export function useCloudStatusQuery() {
  return useQuery({
    queryKey: queryKeys.cloud.status(),
    queryFn: getCloudStatus,
    refetchInterval: (query) => cloudPollInterval(query.state.data),
  })
}

/** The account's devices; this computer's own routes, so only while it is connected. */
export function useCloudDevicesQuery(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.cloud.devices(), queryFn: getCloudDevices, enabled, staleTime: 0 })
}

/** Requests to join, for a signer. Polled every 30 s while enabled. */
export function useCloudPendingQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.cloud.pending(),
    queryFn: getCloudPending,
    enabled,
    staleTime: 0,
    refetchInterval: CLOUD_PENDING_POLL_MS,
    retry: false,
  })
}

function useCloudMutation<V = void>(mutationFn: (variables: V) => Promise<CloudStatus>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.cloud.status(), data)
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloud.devices() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloud.pending() })
    },
  })
}

export const useCloudLoginMutation = () => useCloudMutation((roles: Roles) => cloudLogin(roles))
export const useCloudJoinMutation = () =>
  useCloudMutation(({ link, roles }: { link: string; roles: Roles }) => cloudJoin(link, roles))
export const useCloudCancelMutation = () => useCloudMutation(cloudLoginCancel)
export const useCloudLogoutMutation = () => useCloudMutation(cloudLogout)
export const useCloudConfirmRecovery = () =>
  useCloudMutation(({ first, second }: { first: string; second: string }) => cloudConfirmRecovery(first, second))
/** Removes a device once the person confirms in the desktop app (see `useCloudApproveConfirm`). */
export const useCloudRemoveDevice = () =>
  useCloudMutation(async (deviceId: string) => {
    if (!canApproveHere()) throw new Error(REMOVE_ELSEWHERE)
    const proof = await approvalProof({ action: 'remove', id: deviceId }, 'remove a device from your account')
    if (!proof) throw new Error('Not confirmed. Nothing was removed.')
    return cloudRemoveDevice(deviceId, proof)
  })

export const useCloudApproveBegin = () => useMutation({ mutationFn: (enrollmentId: string) => cloudApproveBegin(enrollmentId) })

/**
 * Adds the device after the person at this computer confirms in the
 * desktop app: Touch ID or the login password where the Mac has one, the
 * click itself elsewhere. The app then gives the proof the server needs for
 * exactly this request; a plain browser has none and says where to approve.
 */
export const useCloudApproveConfirm = () =>
  useCloudMutation(async ({ enrollmentId, approver, roles }: { enrollmentId: string; approver: boolean; roles: Roles }) => {
    if (!canApproveHere()) throw new Error(APPROVE_ELSEWHERE)
    const request = { action: 'approve' as const, id: enrollmentId, signer: approver, ...roles }
    const proof = await approvalProof(request, 'add a device to your account')
    if (!proof) throw new Error('Not confirmed. Nothing was added.')
    return cloudApproveConfirm(enrollmentId, approver, roles, proof)
  })

export const useCloudApproveReject = () => useCloudMutation((enrollmentId: string) => cloudApproveReject(enrollmentId))
