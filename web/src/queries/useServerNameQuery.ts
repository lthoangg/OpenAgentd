import { useQuery } from '@tanstack/react-query'
import { apiBaseUrl } from '@/api/base-url'
import { getServerName, type ServerName } from '@/api/client/server-name'
import { queryKeys } from './keys'
import { useServerCapability } from './useHealthQuery'

export const SERVER_NAME_CAPABILITY = 'api.server_name'

/** A server's name, with the server it was read from. */
export interface ServerNameOf extends ServerName {
  /** `apiBaseUrl()` when it was asked: the app may have switched servers since. */
  origin: string
}

/** `getServerName`, tagged with the server that answered. */
export async function readServerName(signal?: AbortSignal): Promise<ServerNameOf> {
  const origin = apiBaseUrl()
  return { ...(await getServerName(signal)), origin }
}

/**
 * What the connected server's computer calls itself. Off for servers that
 * predate the API. A name changes rarely: it is read when the app connects
 * and after a rename.
 */
export function useServerNameQuery() {
  const supported = useServerCapability(SERVER_NAME_CAPABILITY)
  return useQuery({
    queryKey: queryKeys.serverName(),
    queryFn: ({ signal }) => readServerName(signal),
    enabled: supported,
    staleTime: 10 * 60_000,
    retry: 1,
  })
}
