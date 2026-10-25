/**
 * TaskListPane — search + scheduled-task list, shared by the scheduler
 * overlay and the review dock's Schedule tab.
 */
import { useState } from 'react'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import { AlertCircle, Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchBar } from '@/components/ui/search-bar'
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
  /** Second line of the empty state, telling the user how to create one. */
  emptyHint?: string
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
  emptyHint,
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
          <div role="status" className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <Loader2 size={20} className="animate-spin text-(--color-text-muted)" aria-hidden="true" />
            <p className="text-xs text-(--color-text-muted)">Loading scheduled tasks…</p>
          </div>
        ) : isError ? (
          <EmptyState
            fill={false}
            tone="error"
            className="px-6 py-12"
            icon={AlertCircle}
            title="Failed to load tasks"
            action={onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : undefined}
          />
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            fill={false}
            className="px-6 py-12"
            icon={Clock}
            title={searchQuery ? 'No tasks match your search' : 'No scheduled tasks yet'}
            body={!searchQuery ? emptyHint : undefined}
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
