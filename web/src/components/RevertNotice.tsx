import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Redo2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Collapsible } from '@/components/ui/collapsible'
import { designFeedbackPlainText } from '@/lib/design-feedback'

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
  const label = count === 1 ? '1 message undone' : `${count} messages undone`

  return (
    <div className="my-2 flex justify-center">
      <div className="flex w-full max-w-xl flex-col gap-1.5 text-xs text-(--color-text-muted)">
        <Collapsible open={expanded && messages.length > 0}>
          <div className="max-h-44 overflow-y-auto overscroll-contain touch-pan-y rounded-sm border border-(--color-border) bg-(--bg-card) p-2">
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className="px-2 py-1.5 not-last:border-b not-last:border-(--color-border)"
              >
                <div className="whitespace-pre-wrap text-(--color-text-muted)">{designFeedbackPlainText(message.content)}</div>
              </div>
            ))}
          </div>
        </Collapsible>
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
                  className="group flex items-center gap-1.5 rounded-xs px-2 py-1 transition-colors hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring) pointer-coarse:min-h-11"
                >
                  <Redo2 size={13} aria-hidden="true" className="text-(--color-text-subtle) transition-colors group-hover:text-(--color-accent)" />
                  <span>Redo next message</span>
                </button>
              }
            />
            <TooltipContent>Restore the next undone message and its file changes</TooltipContent>
          </Tooltip>
          {count > 1 && onRedoAll && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onRedoAll}
                    className="group flex items-center gap-1.5 rounded-xs px-2 py-1 transition-colors hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring) pointer-coarse:min-h-11"
                  >
                    <span>Redo all</span>
                  </button>
                }
              />
              <TooltipContent>Restore every undone message and its file changes</TooltipContent>
            </Tooltip>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
