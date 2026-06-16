/** TanStack Query hooks for the skill CRUD API. */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listSkillFiles,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
} from '@/api/client'
import { queryKeys } from './keys'

export function useSkillFilesQuery() {
  return useQuery({
    queryKey: queryKeys.skillFiles.list(),
    queryFn: listSkillFiles,
    staleTime: 10_000,
  })
}

export function useSkillFileQuery(name: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.skillFiles.detail(name ?? ''),
    queryFn: () => getSkill(name as string),
    enabled: !!name,
  })
}

function invalidateAll(client: ReturnType<typeof useQueryClient>) {
  client.invalidateQueries({ queryKey: queryKeys.skillFiles.all() })
  // Skills appear in the registry response and can affect agent reload.
  client.invalidateQueries({ queryKey: queryKeys.agentFiles.all() })
  client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
  client.invalidateQueries({ queryKey: queryKeys.agents() })
}

export function useCreateSkillMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      createSkill(name, content),
    onSuccess: () => invalidateAll(client),
  })
}

export function useUpdateSkillMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      updateSkill(name, content),
    onSuccess: (_data, { name }) => {
      invalidateAll(client)
      client.invalidateQueries({ queryKey: queryKeys.skillFiles.detail(name) })
    },
  })
}

export function useDeleteSkillMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => deleteSkill(name),
    onSuccess: () => invalidateAll(client),
  })
}
