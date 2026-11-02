import { Clock, Plus } from 'lucide-react'
import { useScheduledTasksQuery } from '@/queries'
import { NEW_SCHEDULED_TASK, useUIStore } from '@/stores/useUIStore'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { formatCompactUpcoming } from '@/utils/format'
import { ROW_ACTION, ROW_TEXT_ACTION, listRowClass } from '@/components/ui/list-row'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SidebarHeading } from './SidebarHeading'

const MAX_ROWS = 5

/**
 * Scheduled tasks under the workspace tree: always there, so a task can be
 * created from the sidebar. The heading counts the enabled tasks and has a
 * "+" for a new one; the next few to run are listed, each opening its
 * detail.
 */
export function ScheduledSection({ onMobileClose }: { onMobileClose?: () => void }) {
  const { data, isPending } = useScheduledTasksQuery()
  const tasks = data?.tasks ?? []
  const enabled = tasks.filter((task) => task.enabled)
  const upcoming = enabled
    .filter((task) => task.next_fire_at)
    .sort((a, b) => Date.parse(a.next_fire_at ?? '') - Date.parse(b.next_fire_at ?? ''))

  const open = (taskId: string | null) => {
    useUIStore.getState().focusScheduledTask(taskId)
    dispatchAppEvent(APP_EVENTS.openScheduler)
    onMobileClose?.()
  }
  const now = new Date()

  return (
    <section aria-label="Scheduled" className="shrink-0 pb-1.5">
      <SidebarHeading
        label="Scheduled"
        count={isPending ? undefined : enabled.length}
        actions={(
          <Tooltip>
            <TooltipTrigger
              render={
                <button type="button" onClick={() => open(NEW_SCHEDULED_TASK)} className={ROW_ACTION} aria-label="New scheduled task">
                  <Plus size={12} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>New scheduled task</TooltipContent>
          </Tooltip>
        )}
      />
      {upcoming.length > 0 ? (
        <ul className="space-y-px px-1.5">
          {upcoming.slice(0, MAX_ROWS).map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => open(task.id)}
                className={listRowClass()}
              >
                <Clock size={12} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
                <span className="min-w-0 flex-1 truncate font-medium">{task.name}</span>
                <span className="shrink-0 font-mono text-meta tabular-nums text-(--color-text-muted)">
                  {formatCompactUpcoming(task.next_fire_at, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : !isPending && (
        <div className="flex items-center gap-1 px-3 text-meta text-(--color-text-muted)">
          <span className="min-w-0 flex-1 truncate">{tasks.length === 0 ? 'No scheduled tasks' : 'Nothing due'}</span>
          <button type="button" onClick={() => open(null)} className={ROW_TEXT_ACTION}>
            Open
          </button>
        </div>
      )}
    </section>
  )
}
