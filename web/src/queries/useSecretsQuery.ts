/**
 * TanStack Query hooks for the secrets the user gives the agent. The list
 * holds names and projects only; a value goes up through the save mutation
 * and is never read back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { deleteSecret, listSecrets, saveSecret } from '@/api/client'
import { queryKeys } from './keys'

type SaveSecretBody = Parameters<typeof saveSecret>[1]

export function useSecretsQuery() {
  return useQuery({
    queryKey: queryKeys.settings.secrets(),
    queryFn: () => listSecrets(),
    staleTime: 30_000,
  })
}

/**
 * `gcTime: 0` so the mutation (whose variables hold the typed value) leaves
 * the cache as soon as nothing observes it.
 */
export function useSaveSecretMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: SaveSecretBody }) => saveSecret(name, body),
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings.secrets() }),
  })
}

export function useDeleteSecretMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, id }: { name: string; id: string }) => deleteSecret(name, id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings.secrets() }),
  })
}
