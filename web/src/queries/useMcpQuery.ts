/** TanStack Query hooks for the MCP server CRUD API. */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  restartMcpServer,
  connectMcpOAuth,
  type ServerBody,
  type ServerStatus,
} from '@/api/client'
import { queryKeys } from './keys'
import { CAPABILITY, useServerCapability } from './useHealthQuery'

/** How often to re-poll while a server is mid-handshake. */
export const MCP_STARTING_POLL_MS = 2_000

/**
 * Poll interval for the server list: keep refetching only while an enabled
 * server is still coming up, so a freshly enabled server visibly settles into
 * `ready` instead of sitting on `starting` until the panel is reopened. A
 * disabled server never leaves `starting` on its own, so it must not keep the
 * poll alive forever.
 */
export function mcpPollInterval(servers: ServerStatus[] | undefined): number | false {
  const starting = servers?.some((s) => s.enabled && s.state === 'starting') ?? false
  return starting ? MCP_STARTING_POLL_MS : false
}

export function useMcpServersQuery(options?: { pollWhileStarting?: boolean }) {
  // Servers that push `mcp_status_changed` need no polling: the global event
  // stream invalidates this query when a server settles.
  const pushed = useServerCapability(CAPABILITY.mcpEvents)
  return useQuery({
    queryKey: queryKeys.mcp.list(),
    queryFn: listMcpServers,
    staleTime: 10_000,
    // Opt-in: only surfaces that show live state want the extra traffic.
    refetchInterval: options?.pollWhileStarting && !pushed
      ? (query) => mcpPollInterval(query.state.data?.servers)
      : undefined,
  })
}

export function useMcpServerQuery(name: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.mcp.detail(name ?? ''),
    queryFn: () => getMcpServer(name as string),
    enabled: !!name,
  })
}

function invalidateAll(client: ReturnType<typeof useQueryClient>) {
  client.invalidateQueries({ queryKey: queryKeys.mcp.all() })
}

export function useCreateMcpServerMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, server }: { name: string; server: ServerBody }) =>
      createMcpServer(name, server),
    onSuccess: () => invalidateAll(client),
  })
}

export function useUpdateMcpServerMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, server }: { name: string; server: ServerBody }) =>
      updateMcpServer(name, server),
    // The list shows the saved config at once (a switch flips in the same
    // frame); a refused save puts the previous list back.
    onMutate: async ({ name, server }) => {
      await client.cancelQueries({ queryKey: queryKeys.mcp.list() })
      const previous = client.getQueryData<{ servers: ServerStatus[] }>(queryKeys.mcp.list())
      patchListedServer(client, name, (s) => ({
        ...s,
        config: server,
        enabled: server.enabled,
        // Enabling starts the server; show that rather than its old `stopped`.
        ...(server.enabled && !s.enabled ? { state: 'starting' as const, error: null } : {}),
      }))
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(queryKeys.mcp.list(), context.previous)
    },
    onSuccess: (data, { name }) => {
      // The editor compares its draft against this; writing the answer now
      // keeps a just-saved form from reading as dirty until the refetch.
      client.setQueryData(queryKeys.mcp.detail(name), data)
      patchListedServer(client, name, () => data)
      invalidateAll(client)
    },
  })
}

function patchListedServer(
  client: ReturnType<typeof useQueryClient>,
  name: string,
  patch: (server: ServerStatus) => ServerStatus,
) {
  client.setQueryData<{ servers: ServerStatus[] }>(queryKeys.mcp.list(), (old) =>
    old && { ...old, servers: old.servers.map((s) => (s.name === name ? patch(s) : s)) },
  )
}

export function useDeleteMcpServerMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => deleteMcpServer(name),
    onSuccess: () => invalidateAll(client),
  })
}

export function useRestartMcpServerMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => restartMcpServer(name),
    onSuccess: (_data, name) => {
      client.invalidateQueries({ queryKey: queryKeys.mcp.detail(name) })
    },
  })
}

export function useConnectMcpOAuthMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => connectMcpOAuth(name),
    onSettled: (_data, _error, name) => {
      client.invalidateQueries({ queryKey: queryKeys.mcp.detail(name) })
      invalidateAll(client)
    },
  })
}
