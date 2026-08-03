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
  return useQuery({
    queryKey: queryKeys.mcp.list(),
    queryFn: listMcpServers,
    staleTime: 10_000,
    // Opt-in: only surfaces that show live state want the extra traffic.
    refetchInterval: options?.pollWhileStarting
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
    onSuccess: (_data, { name }) => {
      invalidateAll(client)
      client.invalidateQueries({ queryKey: queryKeys.mcp.detail(name) })
    },
  })
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
