// Scheduled tasks.

export interface ScheduledTaskResponse {
  id: string
  slug: string
  name: string
  workspace: string
  schedule_type: 'at' | 'every' | 'cron'
  at_datetime: string | null
  every_seconds: number | null
  cron_expression: string | null
  timezone: string
  prompt: string
  session_id: string | null
  max_runs: number | null
  enabled: boolean
  status: string
  run_count: number
  last_run_at: string | null
  last_error: string | null
  next_fire_at: string | null
  created_at: string
  updated_at: string
}

export interface ScheduledTaskCreate {
  name: string
  slug?: string
  workspace: string
  schedule_type: 'at' | 'every' | 'cron'
  at_datetime?: string | null
  every_seconds?: number | null
  cron_expression?: string | null
  timezone?: string
  prompt: string
  session_id?: string | null
  max_runs?: number | null
  enabled?: boolean
}

export interface ScheduledTaskListResponse {
  tasks: ScheduledTaskResponse[]
}

export interface TaskTriggerResponse {
  status: string
}
