/**
 * The notice above the composer after Undo: one container, the caption in
 * words, one row of actions.
 *
 * One word pair for the whole feature — Undo and Redo. The caption says what
 * is undone and what happens next (Redo brings it back; a new message
 * discards it), so nothing here lives in a tooltip alone. The undone messages
 * can be opened under the row. When the store knows which files the undos
 * changed back, the caption counts them and they are listed name first, so
 * Undo never changes files without saying which.
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
  /** Workspace paths the undos changed back (added, edited or removed). */
  files?: readonly string[]
  onRedo?: () => void
  onRedoAll?: () => void
}

function undoCaption(count: number, fileCount: number): string {
  const changes = fileCount > 0
    ? ` and ${count === 1 ? 'its' : 'their'} changes to ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
    : ''
  if (count === 1 && !changes) return 'Undid the last message. Redo brings it back; sending a new message discards it.'
  const what = count === 1 ? 'the last message' : `the last ${count} messages`
  return `Undid ${what}${changes}. Redo brings them back; sending a new message discards them.`
}

const NO_FILES: readonly string[] = []

export function RevertNotice({ count, messages = [], files = NO_FILES, onRedo, onRedoAll }: RevertNoticeProps) {
  const [expanded, setExpanded] = useState(false)
  // Collapse whenever the undone count resets to 0 (redo or new session),
  // so the next undo doesn't open already-expanded.
  useEffect(() => {
    if (count === 0) setExpanded(false)
  }, [count])
  if (count <= 0) return null
  const caption = undoCaption(count, files.length)
  const canShow = messages.length > 0

  return (
    <div className="my-2 flex justify-center">
      <div className={cn('flex w-full max-w-xl flex-col gap-2 px-3 py-2.5 text-xs text-(--color-text-muted)', TRANSCRIPT_CARD)}>
        <p className="leading-relaxed">{caption}</p>
        {files.length > 0 && (
          <ul aria-label="Files Undo changed back" className="flex max-h-28 flex-col gap-0.5 overflow-y-auto overscroll-contain font-mono text-meta">
            {files.map((path) => {
              const slash = path.lastIndexOf('/')
              const folder = slash > 0 ? path.slice(0, slash) : ''
              return (
                <li key={path} title={path} className="flex min-w-0 gap-2">
                  <span className="shrink-0 text-(--color-text)">{path.slice(slash + 1)}</span>
                  {folder && <span className="min-w-0 truncate">{folder}</span>}
                </li>
              )
            })}
          </ul>
        )}
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
