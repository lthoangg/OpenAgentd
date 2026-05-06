import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSpeechConfig, putSpeechConfig, type SpeechConfig } from '@/api/client'
import { queryKeys } from './keys'

export function useSpeechConfigQuery() {
  return useQuery({
    queryKey: queryKeys.speech.config(),
    queryFn: getSpeechConfig,
    staleTime: 60_000,
  })
}

export function useUpdateSpeechConfigMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: SpeechConfig) => putSpeechConfig(body),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.speech.config(), data)
    },
  })
}
