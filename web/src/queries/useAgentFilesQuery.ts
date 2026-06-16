/**
 * TanStack Query hooks for the agent file CRUD API.
 *
 * On mutation success, invalidates both the agent file cache (settings UI)
 * and the live /team/agents cache so the team chat header refreshes its
 * badges after a reload.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  getRegistry,
} from '@/api/client'
import { queryKeys } from './keys'

export function useAgentFilesQuery() {
  return useQuery({
    queryKey: queryKeys.agentFiles.list(),
    queryFn: listAgents,
    staleTime: 10_000,
  })
}

export function useAgentFileQuery(name: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.agentFiles.detail(name ?? ''),
    queryFn: () => getAgent(name as string),
    enabled: !!name,
  })
}

export function useRegistryQuery() {
  return useQuery({
    queryKey: queryKeys.agentFiles.registry(),
    queryFn: getRegistry,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

function invalidateTeam(client: ReturnType<typeof useQueryClient>) {
  client.invalidateQueries({ queryKey: queryKeys.agentFiles.all() })
  client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
  client.invalidateQueries({ queryKey: queryKeys.agents() })
  client.invalidateQueries({ queryKey: queryKeys.team.status() })
}

export function useCreateAgentMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      createAgent(name, content),
    onSuccess: () => invalidateTeam(client),
  })
}

export function useUpdateAgentMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      updateAgent(name, content),
    onSuccess: (_data, { name }) => {
      invalidateTeam(client)
      client.invalidateQueries({ queryKey: queryKeys.agentFiles.detail(name) })
    },
  })
}

export function useDeleteAgentMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => deleteAgent(name),
    onSuccess: () => invalidateTeam(client),
  })
}
