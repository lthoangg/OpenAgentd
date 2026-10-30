/**
 * MobileChatActions — the phone header's "More" button and its sheet.
 *
 * The phone header keeps three controls (sidebar, Review panel, More), so
 * everything else for the session lives here, grouped by what it acts on:
 * the session (tasks, its settings, context use, jumping between prompts),
 * the workspace (find file, terminal, scheduled tasks) and the app (command
 * palette). The More button carries the open-task count and the goal ring
 * that the Tasks button used to.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { MoreHorizontal, X } from 'lucide-react'
import type { ReactNode } from 'react'

import type { AgentTopbarTokens } from '@/components/AgentTopbar'
import { Chip } from '@/components/ui/chip'
import { GoalRing } from '@/components/ui/goal-ring'
import { DEFAULT_SUMMARY_TRIGGER_TOKENS } from '@/components/ui/token-meter'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import type { GoalTone } from '@/lib/goal'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { formatCompact, formatSpend } from '@/utils/telemetryFormat'

export interface MobileChatActionsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Live edge-swipe drag offset (px, positive = pushed off-screen right). */
  dragOffset?: number | null
  /** Sheet heading: the session title, then the workspace under it. */
  title: string
  subtitle?: string | null
  /** Task list (popover); disabled when omitted (no session yet). */
  onTasks?: () => void
  /** Open tasks (pending or in progress): the count on More and on the Tasks row. */
  openTasks?: number
  /** A live goal's ring and its one-line state ("Goal 3/50"). */
  goalTone?: GoalTone
  goalText?: string | null
  onSessionSettings: () => void
  /** Context use for the session; the section hides without it. */
  tokens?: AgentTopbarTokens
  onScheduler: () => void
  onOpenTerminal?: () => void
  /** Touch stand-ins for ⌥⌘↑ / ⌥⌘↓; disabled when omitted. */
  onPreviousPrompt?: () => void
  onNextPrompt?: () => void
  /** Find file over the workspace files; disabled when omitted. */
  onQuickOpen?: () => void
  onCommandPalette?: () => void
}

const ROW_CLASS =
  'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-(--color-text) transition-colors hover:bg-(--bg-key) active:bg-(--bg-key)/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:opacity-45'
const GROUP_LABEL_CLASS = 'px-2 pb-1 pt-4 text-xs font-medium text-(--color-text-muted) select-none first:pt-1'

function Row({ onClick, children, trailing }: { onClick?: () => void; children: ReactNode; trailing?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className={ROW_CLASS}>
      <span className="flex-1">{children}</span>
      {trailing}
    </button>
  )
}

export function MobileChatActions({
  open,
  onOpenChange,
  dragOffset = null,
  title,
  subtitle,
  onTasks,
  openTasks = 0,
  goalTone,
  goalText,
  onSessionSettings,
  tokens,
  onScheduler,
  onOpenTerminal,
  onPreviousPrompt,
  onNextPrompt,
  onQuickOpen,
  onCommandPalette,
}: MobileChatActionsProps) {
  // Reduced motion: fade the drawer instead of sliding it 280px. `x` is still
  // applied while a drag is in flight — the drawer has to track the finger,
  // and direct manipulation is not the kind of motion the preference targets.
  const prefersReducedMotion = useReducedMotion()
  const drawerMotion = prefersReducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1, x: dragOffset ?? 0 }, exit: { opacity: 0 } }
    : { initial: { x: 280 }, animate: { x: dragOffset ?? 0 }, exit: { x: 280 } }
  const trigger = tokens?.trigger ?? DEFAULT_SUMMARY_TRIGGER_TOKENS
  const contextPercent = tokens && trigger > 0 ? Math.min(100, Math.round((tokens.input / trigger) * 100)) : 0
  const moreLabel = openTasks > 0 ? `More actions, ${openTasks} open task${openTasks === 1 ? '' : 's'}` : 'More actions'
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-no-drag
              onClick={() => onOpenChange(true)}
              className="relative mr-1 flex size-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:size-11"
              aria-label={moreLabel}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
              {openTasks > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-(--color-accent) px-1 text-center font-mono text-[11px] leading-3.5 text-(--bg-page) pointer-coarse:right-1.5 pointer-coarse:top-1.5"
                >
                  {openTasks > 9 ? '9+' : openTasks}
                </span>
              )}
              {goalTone && <GoalRing tone={goalTone} className="absolute bottom-1 right-1 pointer-coarse:bottom-2 pointer-coarse:right-2" />}
            </button>
          }
        />
        <TooltipContent>{moreLabel}</TooltipContent>
      </Tooltip>

      <AnimatePresence>
        {(open || dragOffset !== null) && (
          <>
            <motion.div
              key="mobile-actions-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: dragOffset !== null ? Math.max(0, Math.min(1, 1 - dragOffset / 280)) : 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: dragOffset !== null || prefersReducedMotion ? 0 : DURATIONS_S.fast }}
              // No `md:hidden`: a landscape phone is wider than md but still
              // mobile (useIsMobile's height rule), and only mobile renders this.
              className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-(--color-overlay)"
              aria-hidden="true"
              onClick={() => onOpenChange(false)}
            />
            <motion.aside
              key="mobile-actions-drawer"
              initial={drawerMotion.initial}
              animate={drawerMotion.animate}
              exit={drawerMotion.exit}
              transition={
                dragOffset !== null || prefersReducedMotion
                  ? { duration: 0 }
                  : { duration: DURATIONS_S.base, ease: EASINGS.inOut }
              }
              // Fixed to the right edge, outside the shell's safe-area padding.
              className="mobile-safe-top pr-safe fixed bottom-0 right-0 z-40 flex w-[min(288px,calc(100vw-2rem))] flex-col overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth)"
              role="dialog"
              aria-modal="true"
              aria-label="More actions"
            >
              <div className="flex items-start justify-between gap-2 border-b border-(--color-border) py-2 pl-4 pr-1">
                <div className="min-w-0 py-1.5">
                  <p className="truncate text-sm font-semibold text-(--color-text)">{title}</p>
                  {subtitle && <p className="truncate text-xs text-(--color-text-muted)">{subtitle}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="flex size-11 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label="Close"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y p-2">
                <div className={GROUP_LABEL_CLASS}>Session</div>
                <Row
                  onClick={onTasks}
                  trailing={
                    <span className="flex items-center gap-1.5">
                      {goalText && <Chip tone="info">{goalText}</Chip>}
                      {openTasks > 0 && <Chip mono>{openTasks} open</Chip>}
                    </span>
                  }
                >
                  Tasks
                </Row>
                <Row onClick={onSessionSettings}>Session settings</Row>
                {tokens && (
                  <dl className="mx-2 my-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-(--bg-key)/50 px-3 py-2 text-xs">
                    <dt className="text-(--color-text-muted)">Context (tokens)</dt>
                    <dd className="whitespace-nowrap text-right font-mono tabular-nums text-(--color-text)">
                      {formatCompact(tokens.input)} / {formatCompact(trigger)} <span className="text-(--color-text-muted)">{contextPercent}%</span>
                    </dd>
                    {tokens.sessionCostUsd !== undefined && (
                      <>
                        <dt className="text-(--color-text-muted)">Spend (est.)</dt>
                        <dd className="text-right font-mono tabular-nums text-(--color-text)">{formatSpend(tokens.sessionCostUsd)}</dd>
                      </>
                    )}
                    <dd className="col-span-2 text-[11px] text-(--color-text-muted)">
                      Older messages are summarized when context reaches {formatCompact(trigger)} tokens.
                    </dd>
                  </dl>
                )}
                <div className={cn('grid grid-cols-2 gap-1')}>
                  <Row onClick={onPreviousPrompt}>Previous prompt</Row>
                  <Row onClick={onNextPrompt}>Next prompt</Row>
                </div>
                <div className={GROUP_LABEL_CLASS}>Workspace</div>
                <Row onClick={onQuickOpen}>Find file</Row>
                <Row onClick={onOpenTerminal}>Terminal</Row>
                <Row onClick={onScheduler}>Scheduled tasks</Row>
                <div className={GROUP_LABEL_CLASS}>App</div>
                <Row onClick={onCommandPalette}>Command palette</Row>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
