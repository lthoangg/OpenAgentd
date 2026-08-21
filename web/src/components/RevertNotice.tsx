import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface RevertNoticeProps {
  count: number
  messages?: Array<{ role: string; content: string }>
  onRedo?: () => void
  onRedoAll?: () => void
}

export function RevertNotice({ count, messages = [], onRedo, onRedoAll }: RevertNoticeProps) {
  const [expanded, setExpanded] = useState(false)
  // Collapse whenever the revert count resets to 0 (redo or new session),
  // so the next undo doesn't open already-expanded.
  useEffect(() => {
    if (count === 0) setExpanded(false)
  }, [count])
  if (count <= 0) return null
  const label = count === 1 ? '1 message reverted' : `${count} messages reverted`

  return (
    <div className="my-2 flex justify-center">
      <div className="flex w-full max-w-xl flex-col gap-1.5 text-xs text-(--color-text-muted)">
        {expanded && messages.length > 0 && (
          <div className="max-h-44 overflow-y-auto overscroll-contain touch-pan-y rounded-sm border border-(--color-border) bg-(--bg-card) p-2">
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className="px-2 py-1.5 not-last:border-b not-last:border-(--color-border)"
              >
                <div className="whitespace-pre-wrap text-(--color-text-muted)">{message.content}</div>
              </div>
            ))}
          </div>
        )}
        <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-1.5">
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1.5 rounded-xs px-2 py-1 transition-colors hover:text-(--color-text)"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            <span>{label}</span>
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onRedo}
                  className="group flex items-center gap-1.5 rounded-xs px-2 py-1 transition-colors hover:text-(--color-text)"
                >
                  <RotateCcw size={13} className="text-(--color-text-subtle) transition-colors group-hover:text-(--color-accent)" />
                  <span>/redo to restore</span>
                </button>
              }
            />
            <TooltipContent>Restore all undone messages and return the workspace to the live tip</TooltipContent>
          </Tooltip>
          {count > 1 && onRedoAll && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onRedoAll}
                    className="group flex items-center gap-1.5 rounded-xs px-2 py-1 transition-colors hover:text-(--color-text)"
                  >
                    <span>/redo-all</span>
                  </button>
                }
              />
              <TooltipContent>Restore all undone messages back to the live tip</TooltipContent>
            </Tooltip>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
