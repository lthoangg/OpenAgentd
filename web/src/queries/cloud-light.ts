/**
 * The account reads the startup path needs (the command palette's "Your
 * computers" on the desktop). They load `@/api/cloud` when a query first runs,
 * so the startup bundle carries neither it nor the approval code that
 * `queries/cloud` brings.
 */
import { useQuery } from '@tanstack/react-query'

import type { CloudStatus } from '@/api/cloud'
import { queryClient } from '@/lib/query-client'
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

const loadCloudApi = () => import('@/api/cloud')

/**
 * The desktop's "Your computers" (Settings → Server, ⌘K → Switch Server…):
 * read on the app's query client.
 */
export function useDesktopCloudStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.cloud.status(),
    queryFn: () => loadCloudApi().then((m) => m.getCloudStatus()),
    enabled,
    refetchInterval: (query) => cloudPollInterval(query.state.data),
    retry: false,
  }, queryClient)
}

export function useDesktopCloudDevices(enabled: boolean) {
  // Each read asks the cloud (60 per device per 10 minutes): refreshed by
  // the list's own 30 s timer, and when the palette opens, not on focus.
  return useQuery({
    queryKey: queryKeys.cloud.devices(),
    queryFn: () => loadCloudApi().then((m) => m.getCloudDevices()),
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  }, queryClient)
}
