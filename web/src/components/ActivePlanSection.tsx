/**
 * ActivePlanSection — the session plan as one row above the task list.
 *
 * The lead writes the plan with the ``plan`` tool, and the backend restates it
 * after every context compaction. Open shows it in the Plan tab (View opens a
 * read-only document where there is no dock); Clear stops using it in the
 * session, so later compactions stop carrying a plan the session has moved
 * past. A workspace plan file stays on disk.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PLAN_STATUS_LABEL, planStatus, type PlanStatus } from '@/lib/plan'
import { cn } from '@/lib/utils'
import { formatCompactRelative, formatRelativeDate } from '@/utils/format'
import type { SessionPlan } from '@/api/types'
import { FileLightbox, type FileLightboxItem } from './FileLightbox'

export interface ActivePlanSectionProps {
  plan: SessionPlan
  onClear: () => void
  /** Open the plan in the Plan tab. Without it, View opens a read-only document. */
  onOpen?: () => void
  clearing?: boolean
  /** Where the plan stands; without it, read from the plan alone. */
  status?: PlanStatus
  /** The status as words, when it says more than the plan's own ("Approved · Running"). */
  statusLabel?: string
  /** Colour of ``statusLabel``; the plan status's own colour by default. */
  statusClassName?: string
  className?: string
}

const STATUS_CLASS: Partial<Record<PlanStatus, string>> = {
  approved: 'text-(--accent-green-text)',
  done: 'text-(--accent-green-text)',
  review: 'text-(--accent-orange-text)',
}

/** The plan's `# ` title, if it has one. */
export function planTitle(content: string): string | null {
  const line = content.split('\n').find((l) => /^#\s+\S/.test(l))
  return line ? line.replace(/^#\s+/, '').trim() : null
}

export function ActivePlanSection({ plan, onClear, onOpen, clearing = false, status, statusLabel, statusClassName, className }: ActivePlanSectionProps) {
  const [doc, setDoc] = useState<FileLightboxItem | null>(null)
  const urlRef = useRef<string | null>(null)
  const releaseUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
  }, [])
  useEffect(() => releaseUrl, [releaseUrl])

  const openPlan = () => {
    releaseUrl()
    urlRef.current = URL.createObjectURL(new Blob([plan.content], { type: 'text/markdown' }))
    setDoc({ type: 'text', src: urlRef.current, name: 'plan.md', textContent: plan.content })
  }
  const closePlan = () => {
    releaseUrl()
    setDoc(null)
  }
  const shown = status ?? planStatus(plan, false)
  const statusClass = statusClassName ?? STATUS_CLASS[shown]
  const statusText = statusLabel ?? PLAN_STATUS_LABEL[shown]
  const title = planTitle(plan.content)

  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-2.5 py-1', className)} data-plan-status={shown}>
      <FileText size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
      <span className="text-xs font-medium text-(--color-text)">Plan</span>
      {title && <span className="min-w-0 truncate text-xs text-(--color-text-2)" title={title}>{title}</span>}
      {plan.revision !== undefined && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle)">rev {plan.revision}</span>
      )}
      {statusClass && <span data-plan-status-label className={cn('shrink-0 text-[11px] font-medium', statusClass)}>{statusText}</span>}
      <span
        className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle)"
        title={`Updated ${formatRelativeDate(plan.updated_at)}`}
      >
        {formatCompactRelative(plan.updated_at)}
      </span>
      <span className="flex-1" aria-hidden="true" />
      {onOpen ? (
        <Button type="button" variant="ghost" size="xs" onClick={onOpen} aria-label="Open plan">
          Open
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="xs" onClick={openPlan} aria-label="View plan">
          View
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onClear}
        disabled={clearing}
        aria-label="Clear plan"
        title="Stops using this plan in the session; the file stays."
      >
        Clear
      </Button>
      {doc && <FileLightbox items={[doc]} isOpen onClose={closePlan} />}
    </div>
  )
}
