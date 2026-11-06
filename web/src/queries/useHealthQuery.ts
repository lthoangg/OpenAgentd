import { useQuery } from '@tanstack/react-query'
import { health } from '@/api/client'
import { queryKeys } from './keys'
import { getAppBackendStatus } from '@/lib/app-backend'

/**
 * Safety net only: the global event stream rechecks health when it drops or
 * reopens (`use-global-event-stream.ts`), so the dot no longer needs a 30 s poll.
 */
export const HEALTH_FALLBACK_POLL_MS = 5 * 60_000

export function useHealthQuery() {
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: health,
    retry: 3,
    retryDelay: 1000,
    // React Query pauses queries while the device is offline, and a paused
    // check never fails: the dot stayed green and the banner never came.
    // This is the one query whose job is to fail then.
    networkMode: 'always',
    refetchInterval: HEALTH_FALLBACK_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

export function useBackendStatusQuery() {
  return useQuery({
    queryKey: queryKeys.backendStatus(),
    queryFn: getAppBackendStatus,
    staleTime: 10_000,
  })
}

/** Server capability names that replace polling or unlock v3-only features. */
export const CAPABILITY = {
  plugins: 'api.plugins',
  configEvents: 'events.config_changed',
  mcpEvents: 'events.mcp_status_changed',
} as const

/**
 * Whether the connected backend advertises `name` in `/health/ready`. False
 * while loading and on v2 (which reports none), so callers keep their v2
 * behaviour (polling, hidden v3-only UI) until the server opts in.
 */
export function useServerCapability(name: string): boolean {
  const { data } = useHealthQuery()
  return data?.capabilities?.includes(name) ?? false
}
