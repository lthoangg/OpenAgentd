/**
 * Design feedback from the Preview tab: the removable chip in the composer
 * and the card a sent message shows instead of the raw block.
 */
import { MousePointerClick, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { type DesignFeedback, designFeedbackSummary } from '@/lib/design-feedback'

/** ``localhost:5173/pricing`` */
function shortWhere(where: string): string {
  return where.replace(/^https?:\/\//, '')
}

function PinNumber({ n }: { n: number }) {
  return (
    <span className="mt-px flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-(--color-accent) px-1 text-[11px] font-semibold text-(--color-text-on-accent)">
      {n}
    </span>
  )
}

/** The composer's chips, one per batch sent from a Preview tab. */
export function DesignFeedbackStrip({ items, onRemove, below = false }: { items: readonly DesignFeedback[]; onRemove: (index: number) => void; below?: boolean }) {
  return (
    <div className={cn(below ? 'mt-3' : 'mb-3', '-mx-2 -my-2')}>
      <div className="overflow-x-auto px-2 py-2">
        <ul aria-label="Design feedback" className="flex w-max flex-nowrap items-center gap-2">
          {items.map((feedback, index) => (
            <li key={index} className="group relative inline-block shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div className="flex items-center gap-2 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 py-1.5 text-xs text-(--color-text)">
                      <MousePointerClick size={14} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
                      <span className="font-medium">{designFeedbackSummary(feedback)}</span>
                      <span className="max-w-40 truncate font-mono text-[11px] text-(--color-text-subtle)">{shortWhere(feedback.where)}</span>
                    </div>
                  }
                />
                <TooltipContent className="max-w-72">
                  <ol className="space-y-0.5">
                    {feedback.items.slice(0, 6).map((item) => (
                      <li key={item.n} className="truncate">
                        {item.n}. {item.comment.split('\n')[0]}
                      </li>
                    ))}
                    {feedback.items.length > 6 && <li>…</li>}
                  </ol>
                </TooltipContent>
              </Tooltip>
              <button
                type="button"
                aria-label="Remove design feedback"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(index)
                }}
                className="absolute -top-2 -right-2 z-10 flex h-7 w-7 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) opacity-100 shadow-(--shadow-depth) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) md:-top-1.5 md:-right-1.5 md:h-4 md:w-4 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              >
                <X size={12} className="md:h-2.5 md:w-2.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** A sent block, as the user sees it in the chat. */
export function DesignFeedbackCard({ feedback, onMentionFileOpen }: { feedback: DesignFeedback; onMentionFileOpen?: (path: string) => void }) {
  return (
    <section
      aria-label={designFeedbackSummary(feedback)}
      className="w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2.5 text-left text-xs text-(--color-text)"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-(--color-text-muted)">
        <MousePointerClick size={12} className="shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">{designFeedbackSummary(feedback)}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-(--color-text-subtle)">
          {shortWhere(feedback.where)}
          {feedback.device ? ` · ${feedback.device}` : ''}
        </span>
      </p>
      <ol className="mt-2 space-y-2">
        {feedback.items.map((item) => {
          const fileRef = item.source?.startsWith('@') ? item.source.slice(1) : null
          return (
            <li key={item.n} className="flex gap-2">
              <PinNumber n={item.n} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] text-(--color-text-subtle)">
                  {item.element}
                  {item.text ? ` "${item.text}"` : ''}
                  {item.page ? ` · ${item.page}` : ''}
                  {item.source && ' · '}
                  {fileRef && onMentionFileOpen ? (
                    <button
                      type="button"
                      data-mention-kind="file"
                      onClick={() => onMentionFileOpen(fileRef)}
                      className="rounded-sm text-(--accent-blue-text) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
                    >
                      {item.source}
                    </button>
                  ) : (
                    item.source && <span className={fileRef ? 'text-(--accent-blue-text)' : undefined}>{item.source}</span>
                  )}
                </p>
                <p className="mt-0.5 leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{item.comment}</p>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
