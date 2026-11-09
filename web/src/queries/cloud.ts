import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  cloudJoin,
  cloudLogin,
  cloudLoginCancel,
  cloudLogout,
  getCloudStatus,
  type CloudStatus,
} from '@/api/cloud'
import { queryKeys } from './keys'

/** How often the status is refetched while a sign-in is waiting on the user. */
export const CLOUD_POLL_MS = 2000

/**
 * Poll only while something is in progress (`signing_in`, `joining`).
 * Otherwise the status refetches on mount and window focus, so nothing runs
 * unless the screen is open.
 */
export function cloudPollInterval(status: CloudStatus | undefined): number | false {
  return status?.state === 'signing_in' || status?.state === 'joining' || status?.state === 'invited' ? CLOUD_POLL_MS : false
}

export function useCloudStatusQuery() {
  return useQuery({
    queryKey: queryKeys.cloud.status(),
    queryFn: getCloudStatus,
    refetchInterval: (query) => cloudPollInterval(query.state.data),
  })
}

function useCloudMutation<V = void>(mutationFn: (variables: V) => Promise<CloudStatus>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.cloud.status(), data)
    },
  })
}

export const useCloudLoginMutation = () => useCloudMutation(cloudLogin)
export const useCloudJoinMutation = () => useCloudMutation((link: string) => cloudJoin(link))
export const useCloudCancelMutation = () => useCloudMutation(cloudLoginCancel)
export const useCloudLogoutMutation = () => useCloudMutation(cloudLogout)
