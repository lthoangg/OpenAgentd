import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getSummarizationSettings,
  updateSummarizationSettings,
  type SummarizationSettings,
} from '@/api/client'
import { queryKeys } from './keys'

export function useSummarizationSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings.summarization(),
    queryFn: getSummarizationSettings,
  })
}

export function useUpdateSummarizationSettingsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SummarizationSettings) => updateSummarizationSettings(body),
    onSuccess: () => {
      // Invalidate the setting itself.
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.summarization() })
      // Invalidate the agent registry and model registry caches — both embed
      // summary_trigger_tokens computed from the effective threshold, so the
      // context ring in the composer (ContextMeter) updates as soon as it saves.
      queryClient.invalidateQueries({ queryKey: queryKeys.agentRegistry() })
      queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
    },
  })
}
