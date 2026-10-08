import { Clock } from 'lucide-react'
import { useScheduledTasksQuery } from '@/queries'
import { useUIStore } from '@/stores/useUIStore'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { formatCompactUpcoming } from '@/utils/format'
import { listRowClass } from '@/components/ui/list-row'

const MAX_ROWS = 5

/** The next few enabled scheduled tasks, pinned under the workspace tree. */
export function ScheduledSection({ onMobileClose }: { onMobileClose?: () => void }) {
  const { data } = useScheduledTasksQuery()
  const upcoming = (data?.tasks ?? [])
    .filter((task) => task.enabled && task.next_fire_at)
    .sort((a, b) => Date.parse(a.next_fire_at ?? '') - Date.parse(b.next_fire_at ?? ''))
  if (upcoming.length === 0) return null

  const open = (taskId: string | null) => {
    useUIStore.getState().focusScheduledTask(taskId)
    dispatchAppEvent(APP_EVENTS.openScheduler)
    onMobileClose?.()
  }
  const now = new Date()

  return (
    <section aria-label="Scheduled" className="shrink-0 border-t border-(--color-border-subtle) pb-1.5">
      <button
        type="button"
        onClick={() => open(null)}
        aria-label="Open scheduler"
        className="flex h-8 w-full items-center gap-1.5 pl-3 pr-1.5 text-left text-[11px] leading-none transition-colors hover:text-(--color-text-2)"
      >
        <span className="label-caps text-(--color-text-subtle)">Scheduled</span>
        <span className="tabular-nums text-(--color-text-subtle)">{upcoming.length}</span>
      </button>
      <ul className="space-y-px px-1.5">
        {upcoming.slice(0, MAX_ROWS).map((task) => (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => open(task.id)}
              className={listRowClass()}
            >
              <Clock size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
              <span className="min-w-0 flex-1 truncate font-medium">{task.name}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle)">
                {formatCompactUpcoming(task.next_fire_at, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
