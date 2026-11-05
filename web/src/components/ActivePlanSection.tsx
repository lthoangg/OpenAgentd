/**
 * ActivePlanSection — the session plan as one row above the task list.
 *
 * The lead writes the plan with the ``plan`` tool, and the backend restates it
 * after every context compaction. The whole row is one tap target, "Open
 * plan": it shows the plan in the Plan tab, or as a read-only document where
 * there is no dock. Clear stops using the plan in the session, so later
 * compactions stop carrying a plan the session has moved past (a workspace
 * plan file stays on disk). The Plan tab has its own Clear, so the row offers
 * Clear only where there is no tab to open.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PLAN_STATUS_LABEL, planStatus, type PlanStatus } from '@/lib/plan'
import { cn } from '@/lib/utils'
import { formatCompactRelative, formatRelativeDate } from '@/utils/format'
import type { SessionPlan } from '@/api/types'
import type { FileLightboxItem } from './FileLightbox'
import { FileLightbox } from './LazyFileLightbox'

export interface ActivePlanSectionProps {
  plan: SessionPlan
  onClear: () => void
  /** Open the plan in the Plan tab, where Clear lives. Without it, the row shows a read-only document and keeps Clear. */
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
  const [confirmClear, setConfirmClear] = useState(false)
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
      <button type="button" aria-label="Open plan" onClick={onOpen ?? openPlan} className={SUMMARY_ROW_BUTTON_CLASS}>
        <FileText size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
        <span className="text-xs font-medium text-(--color-text)">Plan</span>
        {/* Title and status share what the 20rem popover leaves; both truncate, so a long status never pushes the row past the panel. */}
        {title && <span className="min-w-10 truncate text-xs text-(--color-text-2)" title={title}>{title}</span>}
        {plan.revision !== undefined && (
          <span className="shrink-0 font-mono text-meta tabular-nums text-(--color-text-muted)">rev {plan.revision}</span>
        )}
        {statusClass && <span data-plan-status-label title={statusText} className={cn('min-w-0 truncate text-meta font-medium', statusClass)}>{statusText}</span>}
        <span
          className="shrink-0 font-mono text-meta tabular-nums text-(--color-text-muted)"
          title={`Updated ${formatRelativeDate(plan.updated_at)}`}
        >
          {formatCompactRelative(plan.updated_at)}
        </span>
        <span className="flex-1" aria-hidden="true" />
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-(--color-text-subtle)" />
      </button>
      {!onOpen && (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setConfirmClear(true)}
                  disabled={clearing}
                  aria-label="Clear plan…"
                >
                  Clear plan…
                </Button>
              }
            />
            <TooltipContent>Stops using this plan in the session; the file stays.</TooltipContent>
          </Tooltip>
          <ConfirmDialog
            open={confirmClear}
            onOpenChange={setConfirmClear}
            title="Clear this plan?"
            description="The session stops following this plan and the agent no longer sees it. The plan file stays on disk."
            confirmLabel="Clear plan"
            onConfirm={onClear}
          />
        </>
      )}
      {doc && <FileLightbox items={[doc]} isOpen onClose={closePlan} />}
    </div>
  )
}

/**
 * A summary row (plan, goal) as one tap target: it fills the row, so nothing
 * else needs to sit beside it in a narrow panel.
 */
export const SUMMARY_ROW_BUTTON_CLASS =
  '-mx-1.5 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xs px-1.5 py-0.5 text-left transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-9'
