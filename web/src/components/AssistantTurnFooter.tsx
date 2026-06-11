/**
 * Footer rendered at the bottom of a completed assistant turn, plus the
 * `AssistantTurn` wrapper that groups a turn's blocks and decides when to
 * show the footer.
 *
 * Used by both the compact pane (split / unified) and the wide single-agent
 * view. Each view passes its own `renderBlock` so the per-view block visuals
 * (e.g. compact vs roomy `UserBubble`) stay independent.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
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

export function AssistantTurnFooter({ turnBlocks, size = 'compact', onContinue }: AssistantTurnFooterProps) {
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  // lastTurnText walks back to the previous user block; pass the turn directly.
  const textContent = lastTurnText(turnBlocks)
  const lastBlock = turnBlocks[turnBlocks.length - 1]
  const timestamp = lastBlock?.timestamp
  const responseDurationMs = [...turnBlocks]
    .reverse()
    .find((b) => typeof b.responseDurationMs === 'number')
    ?.responseDurationMs
  const modelId = [...turnBlocks]
    .reverse()
    .map((b) => b.extra?.model)
    .find((model): model is string => typeof model === 'string')
  const modelName = shortModelName(modelId)
  const canContinue = Boolean(onContinue && (textContent || turnBlocks.some((b) => b.type === 'tool')))

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
  }, [])

  if (!textContent && !timestamp && !canContinue && responseDurationMs === undefined && !modelName) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textContent)
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null
        setCopied(false)
      }, 1500)
    } catch { /* ignore */ }
  }

  const wrapperClass = size === 'roomy' ? 'mt-1 flex items-center gap-1.5' : 'mt-0.5 flex items-center gap-1'
  const iconSize = size === 'roomy' ? 11 : 10

  return (
    <div className={wrapperClass}>
      {textContent && (
        <button
          onClick={handleCopy}
          className="rounded p-0.5 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
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
          className="rounded p-0.5 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
          aria-label="Continue response"
          title="Continue"
        >
          <Play size={iconSize} />
        </button>
      )}
      {timestamp && <span className="text-(--color-text-subtle) text-xs">{formatTime(timestamp)}</span>}
      {modelName && (
        <span className="font-mono text-(--color-text-subtle) text-xs" title={modelId ?? undefined}>
          {modelName}
        </span>
      )}
      {responseDurationMs !== undefined && (
        <span className="font-mono text-(--color-text-subtle) text-xs" title="Response duration">
          {formatDuration(responseDurationMs)}
        </span>
      )}
    </div>
  )
}

export interface AssistantTurnProps {
  /** Blocks belonging to this turn (no user blocks inside). */
  blocks: ContentBlock[]
  /** Absolute index of `blocks[0]` in the parent's full block list. */
  startIndex: number
  /** Number of finalized blocks (i.e. `stream.blocks.length`); blocks at or
   *  past this index are still in-flight when `isWorking` is true. */
  finalizedCount: number
  /** True while the agent is actively streaming. */
  isWorking: boolean
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

export function AssistantTurn({
  blocks,
  startIndex,
  finalizedCount,
  isWorking,
  isTrailingTurn,
  totalBlocks,
  renderBlock,
  size = 'compact',
  onContinue,
}: AssistantTurnProps) {
  const turnIsStreaming = isWorking && isTrailingTurn
  const canContinue = isTrailingTurn && !isWorking ? onContinue : undefined

  return (
    <div className="space-y-2">
      {blocks.map((block, j) => {
        const absoluteIdx = startIndex + j
        const isStreaming = isWorking && absoluteIdx >= finalizedCount
        return (
          <div key={block.id}>
            {renderBlock({
              block,
              isStreaming,
              isLast: absoluteIdx === totalBlocks - 1,
            })}
          </div>
        )
      })}
      {!turnIsStreaming && <AssistantTurnFooter turnBlocks={blocks} size={size} onContinue={canContinue} />}
    </div>
  )
}
