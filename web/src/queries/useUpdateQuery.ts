import { useMutation, useQuery } from '@tanstack/react-query'

import { getUpdateStatus, installUpdate } from '@/api/client'
import { queryKeys } from './keys'

export function useUpdateStatusQuery() {
  return useQuery({
    queryKey: queryKeys.settings.update(),
    queryFn: getUpdateStatus,
    enabled: false,
  })
}

export function useInstallUpdateMutation() {
  return useMutation({ mutationFn: installUpdate })
}
