/**
 * TaskListPane — search + scheduled-task list, shared by the scheduler
 * overlay and the review dock's Schedule tab.
 */
import { useState } from 'react'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import { AlertCircle, Clock, Loader2 } from 'lucide-react'
import { SearchBar } from '@/components/ui/search-bar'
import type { ScheduledTaskResponse } from '@/api/types'
import { TaskListItem } from './TaskListItem'
import { useSchedulerChrome } from './chrome'

export interface TaskListPaneProps {
  tasks: ScheduledTaskResponse[]
  isLoading: boolean
  isError: boolean
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
            ? 'border-b border-(--color-border-subtle) px-2 py-1.5'
            : 'border-b border-(--color-border) bg-(--bg-sidebar) p-2.5'
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
          <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <Loader2 size={22} className="animate-spin text-(--color-accent)" />
            <p className="text-xs text-(--color-text-muted)">Loading scheduled tasks…</p>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center gap-2.5 p-8 text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-(--color-error-subtle) text-(--color-error)">
              <AlertCircle size={16} />
            </div>
            <p className="text-sm font-medium text-(--color-error)">Failed to load tasks</p>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-card) text-(--color-text-muted)">
              <Clock size={16} />
            </div>
            <div>
              <p className="text-sm font-medium text-(--color-text)">
                {searchQuery ? 'No tasks match your search' : 'No scheduled tasks yet'}
              </p>
              {!searchQuery && emptyHint && (
                <p className="mt-1 text-xs text-(--color-text-subtle)">{emptyHint}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-1.5 p-2">
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
