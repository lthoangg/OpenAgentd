/**
 * TaskListPane — search + scheduled-task list, shared by the scheduler
 * overlay and the review dock's Schedule tab.
 */
import { useState } from 'react'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import { AlertCircle, Clock, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchBar } from '@/components/ui/search-bar'
import { Skeleton } from '@/components/ui/skeleton'
import type { ScheduledTaskResponse } from '@/api/types'
import { TaskListItem } from './TaskListItem'
import { useSchedulerChrome } from './chrome'

export interface TaskListPaneProps {
  tasks: ScheduledTaskResponse[]
  isLoading: boolean
  isError: boolean
  /** Refetch after a failed load; shows a Retry under the error. */
  onRetry?: () => void
  selectedTaskId: string | null
  onSelect: (id: string) => void
  onDeleted: (id: string) => void
  /**
   * The empty state's "New task" action: opens the create form, or, where the
   * form is already beside the list, moves focus to it.
   */
  onCreate?: () => void
  /** Debounce key; distinct per host so two mounted lists never share one. */
  searchKey?: string
}

export function TaskListPane({
  tasks,
  isLoading,
  isError,
  onRetry,
  selectedTaskId,
  onSelect,
  onDeleted,
  onCreate,
  searchKey = 'scheduler-task-search',
}: TaskListPaneProps) {
  const chrome = useSchedulerChrome()
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const updateDebouncedSearchQuery = useDebouncedCallback(setDebouncedSearchQuery, {
    wait: 150,
    key: searchKey,
  })

  const q = debouncedSearchQuery.toLowerCase()
  const filteredTasks = q
    ? tasks.filter((task) => task.name.toLowerCase().includes(q) || (task.workspace ?? '').toLowerCase().includes(q))
    : tasks

  return (
    <>
      <div
        className={
          chrome === 'dock'
            ? 'border-b border-(--color-border-subtle) px-3 py-2'
            : 'border-b border-(--color-border) bg-(--bg-sidebar) px-4 py-3'
        }
      >
        <SearchBar
          placeholder="Search tasks…"
          value={searchQuery}
          onChange={(event) => {
            const nextQuery = event.target.value
            setSearchQuery(nextQuery)
            updateDebouncedSearchQuery(nextQuery)
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        {isLoading ? (
          <TaskListSkeleton />
        ) : isError ? (
          <EmptyState
            fill={false}
            tone="error"
            className="px-6 py-12"
            icon={AlertCircle}
            title="Couldn't load scheduled tasks."
            action={onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : undefined}
          />
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            fill={false}
            className="px-6 py-12"
            icon={Clock}
            title={searchQuery ? 'No tasks match your search' : 'No scheduled tasks yet'}
            action={
              !searchQuery && onCreate ? (
                <Button size="sm" onClick={onCreate}>
                  <Plus size={13} aria-hidden="true" />
                  New task
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="divide-y divide-(--color-border-subtle) border-b border-(--color-border-subtle)">
            {filteredTasks.map((task) => (
              <TaskListItem
                key={task.id}
                task={task}
                isSelected={selectedTaskId === task.id}
                onSelect={() => onSelect(task.id)}
                onDeleted={() => onDeleted(task.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/**
 * Rows shaped like a task row (name, schedule line, chips, last run), so the
 * list does not jump when the tasks land. Fades in after `fast`, so a quick
 * load never flashes it.
 */
function TaskListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading scheduled tasks"
      className="oa-fade-in-late divide-y divide-(--color-border-subtle) border-b border-(--color-border-subtle)"
    >
      {[0, 1, 2].map((row) => (
        <div key={row} className="space-y-2 px-4 py-3">
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-3 w-1/2" />
          <div className="flex gap-1.5">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
          </div>
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  )
}
