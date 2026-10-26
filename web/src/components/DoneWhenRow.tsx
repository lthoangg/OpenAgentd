/**
 * DoneWhenRow — the finish line at the end of the task list: the plan's
 * Done when and whether the goal's completion check has confirmed it.
 * Quiet while the tasks are open, orange while the check is next, blue once
 * met.
 */
import { InlineCodeText } from '@/components/InlineCodeText'
import { cn } from '@/lib/utils'
import type { DoneWhen, DoneWhenState } from '@/lib/work'

const STATE_CLASS: Record<DoneWhenState, string> = {
  open: 'bg-transparent',
  waiting: 'bg-transparent',
  checking: 'bg-(--accent-orange-soft)',
  met: 'bg-(--accent-blue-soft)',
}

const FLAG_CLASS: Record<DoneWhenState, string> = {
  open: 'text-(--color-text-muted)',
  waiting: 'text-(--color-text-muted)',
  checking: 'text-(--accent-orange-text)',
  met: 'text-(--accent-blue-text)',
}

export function DoneWhenRow({ doneWhen, className }: { doneWhen: DoneWhen; className?: string }) {
  return (
    <div
      data-done-when={doneWhen.state}
      className={cn('mt-1 flex items-start gap-2 border-t border-dashed border-(--color-border-subtle) px-3.5 py-2', STATE_CLASS[doneWhen.state], className)}
    >
      <span className={cn('mt-px shrink-0 text-[11px] font-semibold uppercase tracking-wide', FLAG_CLASS[doneWhen.state])}>Done when</span>
      <div className="min-w-0 text-xs leading-4 text-(--color-text-2)">
        <p className="break-words"><InlineCodeText text={doneWhen.text} /></p>
        <p className="mt-0.5 text-[11px] text-(--color-text-subtle)">{doneWhen.note}</p>
      </div>
    </div>
  )
}
