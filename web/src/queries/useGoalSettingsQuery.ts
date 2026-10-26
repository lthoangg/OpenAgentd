import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getGoalSettings, updateGoalSettings, type GoalSettingsUpdate } from '@/api/client'
import { queryKeys } from './keys'

export function useGoalSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings.goals(),
    queryFn: getGoalSettings,
  })
}

export function useUpdateGoalSettingsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: GoalSettingsUpdate) => updateGoalSettings(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.goals(), data)
    },
  })
}
