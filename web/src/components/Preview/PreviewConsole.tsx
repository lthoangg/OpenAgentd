/**
 * The Browser tab's console panel: what the page logged, filtered to
 * errors, warnings or everything. It opens on Errors when there are any,
 * since the toolbar's badge counts those.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CloseButton } from '@/components/ui/close-button'
import { EmptyState } from '@/components/ui/empty-state'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { cn } from '@/lib/utils'
import type { PreviewConsoleEntry } from './preview-protocol'

type ConsoleFilter = 'errors' | 'warnings' | 'all'

const EMPTY_TITLE: Record<ConsoleFilter, string> = {
  errors: 'No errors',
  warnings: 'No warnings',
  all: 'No console output yet',
}

/** Within this many pixels of the end, the list counts as showing the newest line. */
const FOLLOW_SLACK_PX = 24

export function PreviewConsole({ entries, onClear, onClose }: {
  entries: readonly PreviewConsoleEntry[]
  onClear: () => void
  onClose: () => void
}) {
  const errors = entries.filter((e) => e.level === 'error')
  const warnings = entries.filter((e) => e.level === 'warn')
  const [filter, setFilter] = useState<ConsoleFilter>(errors.length ? 'errors' : 'all')
  const shown = filter === 'errors' ? errors : filter === 'warnings' ? warnings : entries
  const listRef = useRef<HTMLOListElement>(null)
  // The newest line stays in view until the list is scrolled up to read an earlier one.
  const followRef = useRef(true)
  useLayoutEffect(() => {
    const list = listRef.current
    if (list && followRef.current) list.scrollTop = list.scrollHeight
  }, [shown.length, filter])

  return (
    <section aria-label="Browser console" className="flex max-h-44 shrink-0 flex-col border-t border-(--color-border) bg-(--bg-page)">
      <div className="flex min-h-8 shrink-0 items-center gap-2 py-1 pr-1 pl-2">
        <SegmentedControl
          label="Console output to show"
          size="sm"
          value={filter}
          onChange={(next) => {
            followRef.current = true
            setFilter(next)
          }}
          options={[
            { value: 'errors', label: `Errors ${errors.length}` },
            { value: 'warnings', label: `Warnings ${warnings.length}` },
            { value: 'all', label: `All ${entries.length}` },
          ]}
        />
        <span className="min-w-0 flex-1" />
        <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-9" onClick={onClear} disabled={!entries.length}>
          Clear
        </Button>
        <CloseButton size="icon-xs" className="pointer-coarse:size-9" label="Close console" tooltip="Close console" onClick={onClose} />
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={SquareTerminal} title={EMPTY_TITLE[filter]} fill={false} className="flex min-h-0 flex-1 justify-center overflow-y-auto py-4" />
      ) : (
        <ol
          ref={listRef}
          aria-label="Console output"
          onScroll={(event) => {
            const list = event.currentTarget
            followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 font-mono text-meta"
        >
          {shown.map((entry, index) => (
            <li
              key={index}
              className={cn(
                'border-b border-(--color-border-subtle) py-0.5 break-words whitespace-pre-wrap',
                entry.level === 'error' ? 'text-(--color-error)' : entry.level === 'warn' ? 'text-(--accent-orange-text)' : 'text-(--color-text-2)',
              )}
            >
              {entry.message}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
