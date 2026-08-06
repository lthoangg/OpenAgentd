import { AnimatePresence, motion } from 'framer-motion'
import { CalendarClock, Check, MoreHorizontal, X } from 'lucide-react'
import { useTeamStore, type AgentStream } from '@/stores/useTeamStore'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { workspaceLabel } from '@/utils/workspace'
import { dotClassFor } from './agentDots'
import { EASINGS } from '@/lib/motion'

export interface MobileChatActionsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Live edge-swipe drag offset (px, positive = pushed off-screen right). */
  dragOffset?: number | null
  mode: 'normal' | 'coding'
  workspace: string | null
  activeAgent: string | null
  agents: string[]
  streams?: Record<string, AgentStream>
  onSelectAgent: (agent: string) => void
  onScheduler: () => void
}

export function MobileChatActions({
  open,
  onOpenChange,
  dragOffset = null,
  mode,
  workspace,
  activeAgent,
  agents,
  streams: streamsProp,
  onSelectAgent,
  onScheduler,
}: MobileChatActionsProps) {
  const storeStreams = useTeamStore((s) => s.agentStreams)
  const streams = streamsProp ?? storeStreams
  // Reduced motion: fade the drawer instead of sliding it 280px. `x` is still
  // applied while a drag is in flight — the drawer has to track the finger,
  // and direct manipulation is not the kind of motion the preference targets.
  const prefersReducedMotion = useReducedMotion()
  const drawerMotion = prefersReducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1, x: dragOffset ?? 0 }, exit: { opacity: 0 } }
    : { initial: { x: 280 }, animate: { x: dragOffset ?? 0 }, exit: { x: 280 } }
  return (
    <>
      <button
        type="button"
        data-no-drag
        onClick={() => onOpenChange(true)}
        className="mr-1 flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
        aria-label="Open chat actions"
        title="Chat actions"
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {(open || dragOffset !== null) && (
          <>
            <motion.div
              key="mobile-actions-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: dragOffset !== null ? Math.max(0, Math.min(1, 1 - dragOffset / 280)) : 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: dragOffset !== null ? 0 : 0.18 }}
              className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-black/60 md:hidden"
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
                  : { duration: 0.22, ease: EASINGS.inOut }
              }
              className="mobile-safe-top fixed bottom-0 right-0 z-40 flex w-[min(272px,calc(100vw-2rem))] flex-col overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-xl md:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Chat actions"
            >
              <div className="border-b border-(--color-border) px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-(--color-text)">
                      {mode === 'coding' && workspace ? workspaceLabel(workspace) : 'Chat actions'}
                    </p>
                    {activeAgent && (
                      <p className="mt-1 truncate font-mono text-xs text-(--color-text-muted)">Active: {activeAgent}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenChange(false)}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Close chat actions"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y p-2">
                {activeAgent && agents.length > 1 && (
                  <>
                    <div className="px-2 py-2 text-xs font-medium text-muted-foreground">Agents</div>
                    {agents.map((name) => (
                      <button
                        type="button"
                        key={name}
                        onClick={() => { onSelectAgent(name); onOpenChange(false) }}
                        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-(--bg-key)"
                      >
                        <span className={`h-2 w-2 rounded-full ${dotClassFor(name, streams[name])}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
                        {name === activeAgent && <Check size={13} className="text-(--color-accent)" aria-hidden="true" />}
                      </button>
                    ))}
                  </>
                )}

                <div className="px-2 py-2 text-xs font-medium text-muted-foreground">Session</div>
                <button type="button" onClick={onScheduler} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-(--bg-key)">
                  <CalendarClock size={15} aria-hidden="true" />
                  <span className="flex-1">Scheduler</span>
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
