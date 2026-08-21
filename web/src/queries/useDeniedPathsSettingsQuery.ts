/** TanStack Query hooks for the path denylist settings. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getDeniedPathsSettings,
  updateDeniedPathsSettings,
  type DeniedPathsSettings,
} from '@/api/client'
import { queryKeys } from './keys'

export function useDeniedPathsSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings.deniedPaths(),
    queryFn: getDeniedPathsSettings,
    staleTime: 30_000,
  })
}

export function useUpdateDeniedPathsSettingsMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: DeniedPathsSettings) => updateDeniedPathsSettings(body),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.settings.deniedPaths(), data)
    },
  })
}

export const useSandboxSettingsQuery = useDeniedPathsSettingsQuery
export const useUpdateSandboxSettingsMutation = useUpdateDeniedPathsSettingsMutation
