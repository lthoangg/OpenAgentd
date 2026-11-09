import { useQuery } from '@tanstack/react-query'
import { getServerUpdate } from '@/api/client/server-update'
import { queryKeys } from './keys'
import { useServerCapability } from './useHealthQuery'

export const SERVER_UPDATE_CAPABILITY = 'api.server_update'

/**
 * Whether the connected server has a newer release and can install it
 * itself. Off for servers that predate the API. The server caches the
 * release feed for an hour, so this asks it rarely.
 */
export function useServerUpdateQuery() {
  const supported = useServerCapability(SERVER_UPDATE_CAPABILITY)
  return useQuery({
    queryKey: queryKeys.serverUpdate(),
    queryFn: ({ signal }) => getServerUpdate(false, signal),
    enabled: supported,
    staleTime: 10 * 60_000,
    retry: 1,
  })
}
