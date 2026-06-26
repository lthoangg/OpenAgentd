import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  triggerScheduledTask,
} from '@/api/client'
import type { ScheduledTaskCreate } from '@/api/types'
import { queryKeys } from './keys'

/** GET /scheduler/tasks — list all scheduled tasks */
export function useScheduledTasksQuery() {
  return useQuery({
    queryKey: queryKeys.scheduler.list(),
    queryFn: listScheduledTasks,
    staleTime: 10_000,
  })
}

/** POST /scheduler/tasks — create a new scheduled task */
export function useCreateScheduledTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ScheduledTaskCreate) => createScheduledTask(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    },
  })
}

/** PUT /scheduler/tasks/{slug} — update an existing scheduled task */
export function useUpdateScheduledTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ slug, body }: { slug: string; body: Partial<ScheduledTaskCreate> }) =>
      updateScheduledTask(slug, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    },
  })
}

/** DELETE /scheduler/tasks/{slug} — delete a scheduled task */
export function useDeleteScheduledTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (slug: string) => deleteScheduledTask(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    },
  })
}

/** POST /scheduler/tasks/{slug}/pause — pause a scheduled task */
export function usePauseScheduledTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (slug: string) => pauseScheduledTask(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    },
  })
}

/** POST /scheduler/tasks/{slug}/resume — resume a scheduled task */
export function useResumeScheduledTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (slug: string) => resumeScheduledTask(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    },
  })
}

/** POST /scheduler/tasks/{slug}/trigger — trigger a scheduled task immediately */
export function useTriggerScheduledTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (slug: string) => triggerScheduledTask(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
    },
  })
}
