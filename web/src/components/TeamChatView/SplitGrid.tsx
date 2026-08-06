/**
 * SplitGrid — automatic n-pane grid layout for the `split` view mode.
 *
 * All panes (lead included) are treated equally and follow `agentNames` order.
 * New spawned agents are appended by the store, so they automatically claim the
 * next available split-view slot. Columns grow by square capacity:
 *
 *   1 → fullscreen
 *   2 → side-by-side columns
 *   3 → big left, two stacked right
 *   4 → 2×2
 *   5..9 → three columns, stacked as needed
 *
 * Spawn / dismiss animations are driven by framer-motion: panes fade + scale
 * in on mount, fade + scale out on unmount (offline). The dismissed pane
 * keeps its slot during its exit animation; remaining panes reflow via CSS
 * flex once the unmount completes. We intentionally avoid `layout` here so
 * external container resizes (e.g. sidebar collapse) don't trigger pane
 * layout animations.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { AgentPane } from '../AgentPane'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { useTeamStore, type AgentStream } from '@/stores/useTeamStore'

interface SplitGridProps {
  agentNames: string[]
  leadName: string | null
  agentStreams?: Record<string, AgentStream>
  isContinuing?: boolean
  onContinue?: () => void
}

// Exit is faster than enter so dismissal stays readable without delaying the
// next interaction.
export function SplitGrid({
  agentNames, leadName, agentStreams: streamsProp, isContinuing = false, onContinue,
}: SplitGridProps) {
  const storeStreams = useTeamStore((s) => s.agentStreams)
  const agentStreams = streamsProp ?? storeStreams
  const prefersReducedMotion = useReducedMotion()

  const visibleAgentNames = agentNames.filter((name) => {
    const stream = agentStreams[name]
    return stream && stream.status !== 'offline'
  })

  if (visibleAgentNames.length === 0) return null

  const enterTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: DURATIONS_S.base, ease: EASINGS.springSoft }
  const exitTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: DURATIONS_S.fast, ease: EASINGS.springSoft }

  const renderPanel = (name: string) => {
    const stream = agentStreams[name]
    if (!stream) return null
    return (
      <motion.div
        key={name}
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98, transition: exitTransition }}
        transition={enterTransition}
        className="min-h-0 flex-1"
      >
        <AgentPane
          name={name}
          stream={stream}
          isLead={name === leadName}
          isContinuing={isContinuing && name === leadName}
          onContinue={name === leadName ? onContinue : undefined}
        />
      </motion.div>
    )
  }

  const columnCount = Math.ceil(Math.sqrt(visibleAgentNames.length))
  const baseColumnSize = Math.floor(visibleAgentNames.length / columnCount)
  const extraColumns = visibleAgentNames.length % columnCount
  const columns: string[][] = []
  let offset = 0

  for (let col = 0; col < columnCount; col += 1) {
    const size = baseColumnSize + (col >= columnCount - extraColumns ? 1 : 0)
    columns.push(visibleAgentNames.slice(offset, offset + size))
    offset += size
  }

  return (
    <div className="flex h-full flex-col gap-2 lg:flex-row">
      {columns.map((column, idx) => (
        <div key={idx} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <AnimatePresence initial={false}>
            {column.map(renderPanel)}
          </AnimatePresence>
        </div>
      ))}
    </div>
  )
}
