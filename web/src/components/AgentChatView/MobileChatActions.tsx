import { AnimatePresence, motion } from 'framer-motion'
import { CalendarClock, ChevronDown, ChevronUp, Command, FileSearch, MoreHorizontal, Search, TerminalSquare, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { workspaceLabel } from '@/utils/workspace'
import { EASINGS } from '@/lib/motion'

export interface MobileChatActionsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Live edge-swipe drag offset (px, positive = pushed off-screen right). */
  dragOffset?: number | null
  workspace: string | null
  onScheduler: () => void
  onFindInTranscript?: () => void
  onOpenTerminal?: () => void
  /** Touch stand-ins for ⌥⌘↑ / ⌥⌘↓; disabled when omitted. */
  onPreviousPrompt?: () => void
  onNextPrompt?: () => void
  /** Quick Open over the workspace files; disabled when omitted. */
  onQuickOpen?: () => void
  onCommandPalette?: () => void
}

const ROW_CLASS = 'flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-(--bg-key) active:bg-(--bg-key)/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 disabled:opacity-45'
// Same group heading as the command palette and the sidebar (label-caps).
const GROUP_LABEL_CLASS = 'px-2 pb-1 pt-3 label-caps text-(--color-text-subtle) select-none first:pt-1'

export function MobileChatActions({
  open,
  onOpenChange,
  dragOffset = null,
  workspace,
  onScheduler,
  onFindInTranscript,
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
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-no-drag
              onClick={() => onOpenChange(true)}
              className="mr-1 flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
              aria-label="Open chat actions"
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          }
        />
        <TooltipContent>Chat actions</TooltipContent>
      </Tooltip>

      <AnimatePresence>
        {(open || dragOffset !== null) && (
          <>
            <motion.div
              key="mobile-actions-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: dragOffset !== null ? Math.max(0, Math.min(1, 1 - dragOffset / 280)) : 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: dragOffset !== null ? 0 : 0.18 }}
              className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-(--color-overlay) md:hidden"
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
              className="mobile-safe-top fixed bottom-0 right-0 z-40 flex w-[min(272px,calc(100vw-2rem))] flex-col overflow-hidden border-l border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth) md:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Chat actions"
            >
              <div className="border-b border-(--color-border) px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-(--color-text)">
                      {workspace ? workspaceLabel(workspace) : 'Choose a workspace'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenChange(false)}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Close chat actions"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y p-2">
                <div className={GROUP_LABEL_CLASS}>Session</div>
                <button
                  type="button"
                  onClick={onFindInTranscript}
                  disabled={!onFindInTranscript}
                  className={ROW_CLASS}
                >
                  <Search size={14} aria-hidden="true" />
                  <span className="flex-1">Find in transcript</span>
                </button>
                <button type="button" onClick={onPreviousPrompt} disabled={!onPreviousPrompt} className={ROW_CLASS}>
                  <ChevronUp size={14} aria-hidden="true" />
                  <span className="flex-1">Previous prompt</span>
                </button>
                <button type="button" onClick={onNextPrompt} disabled={!onNextPrompt} className={ROW_CLASS}>
                  <ChevronDown size={14} aria-hidden="true" />
                  <span className="flex-1">Next prompt</span>
                </button>
                <button type="button" onClick={onScheduler} className={ROW_CLASS}>
                  <CalendarClock size={14} aria-hidden="true" />
                  <span className="flex-1">Scheduler</span>
                </button>
                <div className={GROUP_LABEL_CLASS}>Workspace</div>
                <button type="button" onClick={onQuickOpen} disabled={!onQuickOpen} className={ROW_CLASS}>
                  <FileSearch size={14} aria-hidden="true" />
                  <span className="flex-1">Search files</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenTerminal}
                  disabled={!onOpenTerminal}
                  className={ROW_CLASS}
                >
                  <TerminalSquare size={14} aria-hidden="true" />
                  <span className="flex-1">Open terminal</span>
                </button>
                <div className={GROUP_LABEL_CLASS}>App</div>
                <button type="button" onClick={onCommandPalette} disabled={!onCommandPalette} className={ROW_CLASS}>
                  <Command size={14} aria-hidden="true" />
                  <span className="flex-1">Command palette</span>
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
