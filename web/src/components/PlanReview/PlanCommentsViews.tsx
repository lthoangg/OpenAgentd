/**
 * Plan comments sent from the Plan tab: the removable chip in the composer
 * and the card a sent message shows instead of the raw block. They look like
 * the Browser tab's design feedback (``DesignFeedbackViews``).
 */
import { FileText, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { planCommentsSummary, type PlanCommentsBlock } from './plan-comments-block'

function Revision({ revision }: { revision: number | null }) {
  if (revision == null) return null
  return <span className="shrink-0 font-mono text-meta tabular-nums text-(--color-text-subtle)">rev {revision}</span>
}

/** The composer's chip: one per message, its x hands the comments back to the plan. */
export function PlanCommentsChip({ block, onRemove, below = false }: { block: PlanCommentsBlock; onRemove: () => void; below?: boolean }) {
  return (
    <div className={cn(below ? 'mt-3' : 'mb-3', '-mx-2 -my-2')}>
      <div className="px-2 py-2">
        <div className="group relative inline-block max-w-full">
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  data-plan-comments-chip=""
                  // Room on the right for the x that sits over the chip's corner.
                  className="flex min-w-0 items-center gap-2 rounded-sm border border-(--color-border) bg-(--bg-card) py-1.5 pr-6 pl-2.5 text-xs text-(--color-text) md:pr-5"
                >
                  <FileText size={14} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
                  <span className="truncate font-medium">{planCommentsSummary(block)}</span>
                  <Revision revision={block.revision} />
                </div>
              }
            />
            <TooltipContent className="max-w-72">
              <ol className="space-y-0.5">
                {block.comments.slice(0, 6).map((comment, index) => (
                  <li key={index} className="truncate">
                    {index + 1}. {comment.text.split('\n')[0]}
                  </li>
                ))}
                {block.comments.length > 6 && <li>…</li>}
              </ol>
            </TooltipContent>
          </Tooltip>
          <button
            type="button"
            aria-label="Put the comments back in the plan"
            title="Put the comments back in the plan"
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
            className="touch-hit absolute -top-2 -right-2 z-10 flex h-7 w-7 items-center justify-center rounded-sm bg-(--bg-card) text-(--color-text-muted) opacity-100 shadow-(--shadow-depth) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:-top-1.5 md:-right-1.5 md:h-6 md:w-6"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

/** A sent block, as the user sees it in the chat: each passage, then the comment on it. */
export function PlanCommentsCard({ block }: { block: PlanCommentsBlock }) {
  return (
    <section
      aria-label={planCommentsSummary(block)}
      data-plan-comments-card=""
      className="w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2.5 text-left text-xs text-(--color-text)"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-(--color-text-muted)">
        <FileText size={12} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">{planCommentsSummary(block)}</span>
        <Revision revision={block.revision} />
      </p>
      <ol className="mt-2 space-y-2">
        {block.comments.map((comment, index) => (
          <li key={index} className="flex gap-2">
            <span className="mt-px flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-(--color-accent) px-1 text-meta font-semibold text-(--color-text-on-accent)">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              {comment.quote && (
                <p className="line-clamp-2 border-l-2 border-(--color-border-strong) pl-1.5 leading-relaxed break-words text-(--color-text-muted)">
                  {comment.quote.replace(/\s+/g, ' ')}
                </p>
              )}
              {comment.text && (
                <p className="mt-0.5 leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.text}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
