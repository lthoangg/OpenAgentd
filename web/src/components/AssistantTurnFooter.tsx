/**
 * Footer rendered at the bottom of a completed assistant turn, plus the
 * `AssistantTurn` wrapper that groups a turn's blocks and decides when to
 * show the footer.
 *
 * Used by both the compact pane (split / unified) and the wide single-agent
 * view. Each view passes its own `renderBlock` so the per-view block visuals
 * (e.g. compact vs roomy `UserBubble`) stay independent.
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Copy, Check, Play } from 'lucide-react'
import { formatTime, lastTurnText } from '@/utils/format'
import type { ContentBlock } from '@/api/types'

export interface AssistantTurnFooterProps {
  /** Blocks belonging to a single assistant turn (no user blocks inside). */
  turnBlocks: ContentBlock[]
  /** Visual density: 'compact' for narrow panes, 'roomy' for the wide view. */
  size?: 'compact' | 'roomy'
  /** Continue from this assistant turn. Only passed for the trailing lead turn. */
  onContinue?: () => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

function shortModelName(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return modelId.split(':').at(-1)?.split('/').at(-1) || modelId
}

export const AssistantTurnFooter = memo(function AssistantTurnFooter({ turnBlocks, size = 'compact', onContinue }: AssistantTurnFooterProps) {
  const [copied, setCopied] = useState(false)
  const footerData = useMemo(() => {
    // Me lastTurnText walks back to the previous user block; pass the turn directly
    const textContent = lastTurnText(turnBlocks)
    const lastBlock = turnBlocks[turnBlocks.length - 1]
    let responseDurationMs: number | undefined
    let modelId: string | undefined
    let hasTool = false
    for (let i = turnBlocks.length - 1; i >= 0; i--) {
      const block = turnBlocks[i]
      responseDurationMs ??= typeof block.responseDurationMs === 'number'
        ? block.responseDurationMs
        : undefined
      modelId ??= typeof block.extra?.model === 'string' ? block.extra.model : undefined
      hasTool ||= block.type === 'tool'
      if (responseDurationMs !== undefined && modelId !== undefined && hasTool) break
    }
    return {
      textContent,
      timestamp: lastBlock?.timestamp,
      responseDurationMs,
      modelId,
      modelName: shortModelName(modelId),
      hasTool,
    }
  }, [turnBlocks])
  const { textContent, timestamp, responseDurationMs, modelId, modelName, hasTool } = footerData
  const canContinue = Boolean(onContinue && (textContent || hasTool))

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }, [textContent])

  if (!textContent && !timestamp && !canContinue && responseDurationMs === undefined && !modelName) return null

  const wrapperClass = size === 'roomy' ? 'mt-1 flex items-center gap-1.5' : 'mt-0.5 flex items-center gap-1'
  const iconSize = size === 'roomy' ? 11 : 10

  return (
    <div className={wrapperClass}>
      {textContent && (
        <button
          onClick={handleCopy}
          className="rounded-xs p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
          aria-label="Copy response"
          title="Copy"
        >
          {copied
            ? <Check size={iconSize} className="text-(--color-success)" />
            : <Copy size={iconSize} />}
        </button>
      )}
      {canContinue && onContinue && (
        <button
          onClick={onContinue}
          className="rounded-xs p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
          aria-label="Continue response"
          title="Continue"
        >
          <Play size={iconSize} />
        </button>
      )}
      {modelName && (
        <span className="font-mono text-(--color-text-subtle) text-xs" title={modelId ?? undefined}>
          {modelName}
        </span>
      )}
      {timestamp && <span className="text-(--color-text-subtle) text-xs">{formatTime(timestamp)}</span>}
      {responseDurationMs !== undefined && (
        <span className="font-mono text-(--color-text-subtle) text-xs" title="Response duration">
          {formatDuration(responseDurationMs)}
        </span>
      )}
    </div>
  )
})

export interface AssistantTurnProps {
  /** Blocks belonging to this turn (no user blocks inside). */
  blocks: ContentBlock[]
  /** Absolute index of `blocks[0]` in the parent's full block list. */
  startIndex: number
  /** Number of finalized blocks (i.e. `stream.blocks.length`); blocks at or
   *  past this index are still in-flight when `isWorking` is true. */
  finalizedCount: number
  /** True while the agent is actively streaming. Drives the per-block cursor. */
  isWorking: boolean
  /**
   * True while this pane's turn has not ended — a superset of ``isWorking``
   * that also covers a lead suspended on ``ask_user``, where nothing streams
   * but the turn is still open.
   *
   * Kept separate from ``isWorking`` because the two answer different
   * questions: ``isWorking`` decides whether a *block* is mid-stream, this
   * decides whether the *turn* is over and may show a duration and a Continue.
   * Defaults to ``isWorking`` for callers with no suspendable turn.
   */
  isTurnOpen?: boolean
  /** True when this turn has no user block after it (i.e. trailing). Only
   *  trailing turns can be "live"; any turn followed by a user message is
   *  finalized regardless of `isWorking`. */
  isTrailingTurn: boolean
  /** Total length of the parent's full block list (for `isLast` cursor). */
  totalBlocks: number
  /** Per-view block renderer. */
  renderBlock: (args: { block: ContentBlock; isStreaming: boolean; isLast: boolean }) => ReactNode
  /** Footer density. */
  size?: 'compact' | 'roomy'
  /** Continue from this turn when it is the trailing finalized lead turn. */
  onContinue?: () => void
}

export const AssistantTurn = memo(function AssistantTurn({
  blocks,
  startIndex,
  finalizedCount,
  isWorking,
  isTurnOpen = isWorking,
  isTrailingTurn,
  totalBlocks,
  renderBlock,
  size = 'compact',
  onContinue,
}: AssistantTurnProps) {
  // The footer reports on a *finished* turn, so it waits for the turn to close
  // rather than merely for the stream to stop.
  const turnIsOpen = isTurnOpen && isTrailingTurn
  const canContinue = isTrailingTurn && !isTurnOpen ? onContinue : undefined

  return (
    <div className="space-y-2">
      {blocks.map((block, j) => {
        const absoluteIdx = startIndex + j
        const isLast = absoluteIdx === totalBlocks - 1
        // Only the block currently receiving output is streaming. Earlier
        // blocks of the same turn are finished the moment the next one opens —
        // flagging them too gave every one of them a typewriter rAF loop with
        // nothing to animate. `appendStreamed` only ever fills the last block
        // of a kind, so the block taking deltas is always the trailing one.
        const isStreaming = isWorking && absoluteIdx >= finalizedCount && isLast
        return (
          <div key={block.id}>
            {renderBlock({
              block,
              isStreaming,
              isLast,
            })}
          </div>
        )
      })}
      {!turnIsOpen && <AssistantTurnFooter turnBlocks={blocks} size={size} onContinue={canContinue} />}
    </div>
  )
})
