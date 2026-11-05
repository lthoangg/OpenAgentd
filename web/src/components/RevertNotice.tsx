/**
 * The notice above the composer after Undo: one container, the caption in
 * words, one row of actions.
 *
 * One word pair for the whole feature — Undo and Redo. The caption says what
 * is undone and what happens next (Redo brings it back; a new message
 * discards it), so nothing here lives in a tooltip alone. The undone messages
 * can be opened under the row.
 */
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Collapsible } from '@/components/ui/collapsible'
import { designFeedbackPlainText } from '@/lib/design-feedback'
import { TRANSCRIPT_CARD } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'

interface RevertNoticeProps {
  count: number
  messages?: Array<{ role: string; content: string }>
  onRedo?: () => void
  onRedoAll?: () => void
}

export function RevertNotice({ count, messages = [], onRedo, onRedoAll }: RevertNoticeProps) {
  const [expanded, setExpanded] = useState(false)
  // Collapse whenever the undone count resets to 0 (redo or new session),
  // so the next undo doesn't open already-expanded.
  useEffect(() => {
    if (count === 0) setExpanded(false)
  }, [count])
  if (count <= 0) return null
  const caption =
    count === 1
      ? 'Undid the last message. Redo brings it back; sending a new message discards it.'
      : `Undid the last ${count} messages. Redo brings them back; sending a new message discards them.`
  const canShow = messages.length > 0

  return (
    <div className="my-2 flex justify-center">
      <div className={cn('flex w-full max-w-xl flex-col gap-2 px-3 py-2.5 text-xs text-(--color-text-muted)', TRANSCRIPT_CARD)}>
        <p className="leading-relaxed">{caption}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button type="button" variant="default" size="xs" onClick={onRedo}>
                  Redo
                </Button>
              }
            />
            <TooltipContent>Redo the last message you undid, with its file changes</TooltipContent>
          </Tooltip>
          {count > 1 && onRedoAll && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button type="button" variant="ghost" size="xs" onClick={onRedoAll}>
                    Redo all
                  </Button>
                }
              />
              <TooltipContent>Redo every message you undid, with their file changes</TooltipContent>
            </Tooltip>
          )}
          {canShow && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {expanded ? 'Hide messages' : 'Show messages'}
            </Button>
          )}
        </div>
        <Collapsible open={expanded && canShow}>
          <ul aria-label="Messages you undid" className="flex max-h-44 flex-col gap-2 overflow-y-auto overscroll-contain touch-pan-y">
            {messages.map((message, index) => (
              <li key={`${message.role}-${index}`} className="whitespace-pre-wrap text-(--color-text)">
                {designFeedbackPlainText(message.content)}
              </li>
            ))}
          </ul>
        </Collapsible>
      </div>
    </div>
  )
}
