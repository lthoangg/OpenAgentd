import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getWorkspaceMessagesSettings,
  updateWorkspaceMessagesSettings,
  type WorkspaceMessagesSettings,
} from '@/api/client'
import { queryKeys } from './keys'

export function useWorkspaceMessagesSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings.workspaceMessages(),
    queryFn: getWorkspaceMessagesSettings,
  })
}

export function useUpdateWorkspaceMessagesSettingsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: WorkspaceMessagesSettings) => updateWorkspaceMessagesSettings(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.workspaceMessages() })
    },
  })
}
