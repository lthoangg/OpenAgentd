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
import { Copy, Check } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Term } from '@/components/ui/term'
import { formatMetaDuration } from '@/components/ui/meta-row'
import { formatTime, formatFullDateTime, lastTurnText, shortModelName } from '@/utils/format'
import { formatCompact, formatInt, formatSpend } from '@/utils/telemetryFormat'
import { turnModel } from '@/utils/turns'
import type { ContentBlock } from '@/api/types'
import { useQuestionAwaitsUser } from '@/components/AskUser'
import { TurnChangedFiles, WorkSummaryRow } from '@/components/ReaderTurn'
import { readerSegments, turnChangedFiles } from '@/components/ReaderTurn/segments'
import { useAgentStore } from '@/stores/useAgentStore'
import { openTelemetry } from '@/stores/useTelemetryStore'

export interface AssistantTurnFooterProps {
  /** Blocks belonging to a single assistant turn (no user blocks inside). */
  turnBlocks: ContentBlock[]
  /** Visual density: 'compact' for narrow panes, 'roomy' for the wide view. */
  size?: 'compact' | 'roomy'
}

/** One line of the turn-details popover: a label, then a right-aligned value. */
function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono tabular-nums">{children}</dd>
    </div>
  )
}

/**
 * The meta line under a finished turn (DESIGN.md → Transcript rows):
 * ``20:13 · claude-sonnet-4-6 · 12.0 s · $0.02`` in muted mono, no icons.
 * The line is a button; its popover lists every number with a label
 * (time, full model ID, thinking, duration, tokens in / cached / out, cost)
 * and opens this session in Usage. A popover rather than a tooltip so it
 * works on touch and can hold the link.
 */
export const AssistantTurnFooter = memo(function AssistantTurnFooter({ turnBlocks, size = 'compact' }: AssistantTurnFooterProps) {
  const [copied, setCopied] = useState(false)
  const footerData = useMemo(() => {
    // Me lastTurnText walks back to the previous user block; pass the turn directly
    const textContent = lastTurnText(turnBlocks)
    const lastBlock = turnBlocks[turnBlocks.length - 1]
    let responseDurationMs: number | undefined
    let outputTokens = 0
    let inputTokens: number | undefined
    let cachedTokens: number | undefined
    let costUsd = 0
    for (const block of turnBlocks) {
      const usage = block.usage
      if (!usage) continue
      outputTokens += usage.outputTokens ?? 0
      costUsd += usage.costUsd ?? 0
      if (typeof usage.inputTokens === 'number') inputTokens = (inputTokens ?? 0) + usage.inputTokens
      if (typeof usage.cachedTokens === 'number') cachedTokens = (cachedTokens ?? 0) + usage.cachedTokens
    }
    for (let i = turnBlocks.length - 1; i >= 0; i--) {
      const block = turnBlocks[i]
      if (typeof block.responseDurationMs === 'number') {
        responseDurationMs = block.responseDurationMs
        break
      }
    }
    const model = turnModel(turnBlocks)
    return {
      textContent,
      timestamp: lastBlock?.timestamp,
      responseDurationMs,
      model: model?.model ?? null,
      modelName: shortModelName(model?.model),
      thinkingLevel: model?.thinkingLevel,
      outputTokens,
      inputTokens,
      cachedTokens,
      costUsd: Math.round(costUsd * 1e8) / 1e8,
    }
  }, [turnBlocks])
  const { textContent, timestamp, responseDurationMs, model, modelName, thinkingLevel, outputTokens, inputTokens, cachedTokens, costUsd } = footerData

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }, [textContent])

  const openInUsage = useCallback(() => {
    const session = useAgentStore.getState().sessionId
    openTelemetry(session ? { session } : {})
  }, [])

  if (!textContent && !timestamp && responseDurationMs === undefined && !modelName) return null

  const wrapperClass = size === 'roomy' ? 'mt-1 flex min-w-0 items-center gap-1.5' : 'mt-0.5 flex min-w-0 items-center gap-1'
  const iconSize = size === 'roomy' ? 11 : 10
  const hasUsage = outputTokens > 0 || costUsd > 0

  const parts: ReactNode[] = []
  // One line: the model ID truncates first; time, duration and cost never wrap.
  if (timestamp) parts.push(<span key="time" className="shrink-0">{formatTime(timestamp)}</span>)
  if (modelName) parts.push(<span key="model" data-turn-model className="min-w-0 truncate">{modelName}</span>)
  if (responseDurationMs !== undefined) parts.push(<span key="dur" className="shrink-0">{formatMetaDuration(responseDurationMs)}</span>)
  if (hasUsage) {
    parts.push(
      <span key="cost" className="shrink-0">{costUsd > 0 ? formatSpend(costUsd) : `${formatCompact(outputTokens)} tok`}</span>,
    )
  }
  const summary = [
    timestamp && formatTime(timestamp),
    modelName && (thinkingLevel ? `${modelName} (thinking ${thinkingLevel})` : modelName),
    responseDurationMs !== undefined && formatMetaDuration(responseDurationMs),
    hasUsage && (costUsd > 0 ? formatSpend(costUsd) : `${formatInt(outputTokens)} output tokens`),
  ].filter(Boolean).join(', ')
  const cachePercent = inputTokens && cachedTokens !== undefined && inputTokens > 0
    ? Math.round((cachedTokens / inputTokens) * 100)
    : undefined

  return (
    <div className={wrapperClass}>
      {textContent && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                onClick={handleCopy}
                className="rounded-sm p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) active:scale-90 pointer-coarse:flex pointer-coarse:size-11 pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:p-0"
                aria-label="Copy response"
              >
                {copied
                  ? <Check size={iconSize} className="text-(--color-success)" />
                  : <Copy size={iconSize} />}
              </button>
            }
          />
          <TooltipContent>Copy response</TooltipContent>
        </Tooltip>
      )}
      {parts.length > 0 && (
        <Popover>
          <PopoverTrigger
            aria-label={`Turn details: ${summary}`}
            aria-haspopup="dialog"
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-sm px-1 font-mono text-[11px] tabular-nums text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-11"
          >
            {parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`sep-${i}`} aria-hidden className="shrink-0 opacity-60">·</span>, part]))}
          </PopoverTrigger>
          <PopoverContent align="start" side="top" role="dialog" aria-label="Turn details" className="w-[min(20rem,calc(100vw-1rem))]">
            <dl className="flex flex-col gap-1.5">
              {timestamp && <DetailRow label="Finished">{formatFullDateTime(timestamp)}</DetailRow>}
              {model && <DetailRow label="Model"><span title={model}>{model}</span></DetailRow>}
              {thinkingLevel && <DetailRow label="Thinking">{thinkingLevel}</DetailRow>}
              {responseDurationMs !== undefined && (
                <DetailRow label={<Term definition="turnDuration">Duration</Term>}>{formatMetaDuration(responseDurationMs)}</DetailRow>
              )}
              {inputTokens !== undefined && <DetailRow label="Input tokens">{formatInt(inputTokens)}</DetailRow>}
              {cachedTokens !== undefined && (
                <DetailRow label={<Term definition="cacheHit">Cached input</Term>}>
                  {formatInt(cachedTokens)}{cachePercent !== undefined ? ` (${cachePercent}%)` : ''}
                </DetailRow>
              )}
              {hasUsage && <DetailRow label="Output tokens">{formatInt(outputTokens)}</DetailRow>}
              {costUsd > 0 && (
                <DetailRow label={<Term definition="spendEstimate">Estimated cost</Term>}>${costUsd.toFixed(4)}</DetailRow>
              )}
            </dl>
            <button
              type="button"
              onClick={openInUsage}
              className="self-start rounded-sm text-xs font-medium text-(--accent-blue-text) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-11"
            >
              Open session in Usage
            </button>
          </PopoverContent>
        </Popover>
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
   * decides whether the *turn* is over.
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
  /**
   * Reader mode: the work folds behind one summary row, and a finished
   * turn lists the files it edited (see ``ReaderTurn/segments.ts``).
   */
  reader?: boolean
  /**
   * When the running turn began (epoch ms), i.e. its prompt was sent.
   * Reader mode's work row shows how long the agent has been working.
   */
  startedAt?: number
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
  reader = false,
  startedAt,
}: AssistantTurnProps) {
  // The footer reports on a *finished* turn, so it waits for the turn to close
  // rather than merely for the stream to stop.
  const turnIsOpen = isTurnOpen && isTrailingTurn
  // Narrower: an open turn waiting on ``ask_user`` is not being worked on.
  const turnIsWorking = isWorking && isTrailingTurn
  const awaitsUser = useQuestionAwaitsUser()
  const segments = useMemo(() => (reader ? readerSegments(blocks, awaitsUser) : null), [reader, blocks, awaitsUser])
  const changedFiles = useMemo(() => (reader && !turnIsOpen ? turnChangedFiles(blocks) : []), [reader, turnIsOpen, blocks])
  // A compaction divider ends the fold before it (see ``readerSegments``), so
  // only a fold after the turn's last divider can still be working.
  const lastCompaction = useMemo(() => {
    if (!reader) return -1
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === 'compaction') return i
    return -1
  }, [reader, blocks])

  const renderAt = (j: number) => {
    const block = blocks[j]
    const absoluteIdx = startIndex + j
    const isLast = absoluteIdx === totalBlocks - 1
    // Only the block currently receiving output is streaming. Earlier
    // blocks of the same turn are finished the moment the next one opens —
    // flagging them too gave every one of them a typewriter rAF loop with
    // nothing to animate. `appendStreamed` only ever fills the last block
    // of a kind, so the block taking deltas is always the trailing one.
    // Compaction blocks live in `blocks` directly, so their active streaming
    // state is indicated by `block.extra?.state === 'compacting'`.
    const isCompactionStreaming = isWorking && block.type === 'compaction' && block.extra?.state === 'compacting'
    const isStreaming = isCompactionStreaming || (isWorking && absoluteIdx >= finalizedCount && isLast)
    return (
      <div key={block.id}>
        {renderBlock({
          block,
          isStreaming,
          isLast,
        })}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {segments
        ? segments.map((segment) => {
            if (segment.kind === 'block') return renderAt(segment.index)
            const work = segment.indices.map((j) => blocks[j])
            const lastIndex = segment.indices[segment.indices.length - 1]
            const live = turnIsWorking && segment.indices[0] > lastCompaction
            return (
              <WorkSummaryRow
                // Keyed by its first block so the toggle survives new steps.
                key={`work-${work[0].id}`}
                blocks={work}
                live={live}
                startedAt={startedAt}
                currentStep={live && lastIndex === blocks.length - 1 ? blocks[lastIndex] : null}
              >
                {segment.indices.map(renderAt)}
              </WorkSummaryRow>
            )
          })
        : blocks.map((_, j) => renderAt(j))}
      {changedFiles.length > 0 && <TurnChangedFiles files={changedFiles} />}
      {!turnIsOpen && <AssistantTurnFooter turnBlocks={blocks} size={size} />}
    </div>
  )
})
