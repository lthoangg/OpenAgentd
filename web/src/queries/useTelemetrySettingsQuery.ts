import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getTelemetrySettings, updateTelemetrySettings, type TelemetrySettingsUpdate } from '@/api/client'
import { queryKeys } from './keys'

export function useTelemetrySettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings.telemetry(),
    queryFn: getTelemetrySettings,
  })
}

export function useUpdateTelemetrySettingsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TelemetrySettingsUpdate) => updateTelemetrySettings(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.telemetry(), data)
      // A shorter retention deletes old traces, so cached telemetry may be stale.
      void queryClient.invalidateQueries({ queryKey: ['observability'] })
    },
  })
}
