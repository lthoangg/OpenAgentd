/**
 * Footer rendered at the bottom of a completed assistant turn, plus the
 * `AssistantTurn` wrapper that groups a turn's blocks and decides when to
 * show the footer.
 *
 * Used by both the compact pane (split / unified) and the wide single-agent
 * view. Each view passes its own `renderBlock` so the per-view block visuals
 * (e.g. compact vs roomy `UserBubble`) stay independent.
 */
import { memo, useCallback, useId, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy, FileDiff, Pencil, Undo2, type LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Collapsible } from '@/components/ui/collapsible'
import { Term } from '@/components/ui/term'
import { formatMetaDuration } from '@/components/ui/meta-row'
import { ModelName } from '@/components/ui/model-name'
import { cn } from '@/lib/utils'
import { PINNED_HEADER, useStickyFold } from '@/hooks/useStickyFold'
import { formatTime, formatFullDateTime, lastTurnText } from '@/utils/format'
import { formatCompact, formatInt, formatSpend } from '@/utils/telemetryFormat'
import { turnAccount, turnModel } from '@/utils/turns'
import type { ContentBlock } from '@/api/types'
import { useQuestionAwaitsUser } from '@/components/AskUser'
import { WorkSummaryRow } from '@/components/ReaderTurn'
import { readerSegments, turnChangedFiles } from '@/components/ReaderTurn/segments'
import type { ChangedFileInfo } from '@/components/WorkspacePanel/diff-helpers'
import { TurnFileList } from '@/components/AgentView/TurnFileList'
import { useAgentStore } from '@/stores/useAgentStore'
import { openTelemetry } from '@/stores/useTelemetryStore'

export interface AssistantTurnFooterProps {
  /** Blocks belonging to a single assistant turn (no user blocks inside). */
  turnBlocks: ContentBlock[]
  /** Visual density: 'compact' for narrow panes, 'roomy' for the wide view. */
  size?: 'compact' | 'roomy'
  /** Files the turn edited; listed behind "N files changed". */
  changedFiles?: readonly ChangedFileInfo[]
  /** Edit the prompt this turn answers. */
  onEditPrompt?: () => void
  /** A turn is running, so the prompt cannot be edited yet: the action shows disabled, with the reason. */
  editLocked?: boolean
  /** Undo this turn; offered under the last finished turn only. */
  onUndo?: () => void
}

const NO_FILES: readonly ChangedFileInfo[] = []

/**
 * An icon action on the footer (DESIGN.md → Transcript rows): muted, shown
 * at rest, a keycap wash on hover, its words in the name and the tooltip.
 * 24px square, 36px on touch, like the prompt's own Edit and Copy.
 */
const ACTION_CLASS = 'inline-flex size-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-muted) transition-[color,background-color,scale] duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text-2) active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:size-9'

/** The files toggle carries numbers, so it is a short pill, not a square. */
const FILES_CLASS = 'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-1.5 text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text-2) aria-expanded:bg-(--bg-key) aria-expanded:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:h-9 pointer-coarse:px-2.5'

/** A footer icon action with its hint on hover and keyboard focus. */
function FooterAction({ icon: Icon, label, hint, onClick, iconClassName }: { icon: LucideIcon; label: string; hint: string; onClick: () => void; iconClassName?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <button type="button" onClick={onClick} aria-label={label} className={ACTION_CLASS}>
            <Icon size={13} aria-hidden="true" className={iconClassName} />
          </button>
        )}
      />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
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
export const AssistantTurnFooter = memo(function AssistantTurnFooter({
  turnBlocks,
  size = 'compact',
  changedFiles = NO_FILES,
  onEditPrompt,
  editLocked = false,
  onUndo,
}: AssistantTurnFooterProps) {
  const [copied, setCopied] = useState(false)
  const filesFold = useStickyFold()
  const filesId = useId()
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
      account: turnAccount(turnBlocks),
      textContent,
      timestamp: lastBlock?.timestamp,
      responseDurationMs,
      model: model?.model ?? null,
      thinkingLevel: model?.thinkingLevel,
      outputTokens,
      inputTokens,
      cachedTokens,
      costUsd: Math.round(costUsd * 1e8) / 1e8,
    }
  }, [turnBlocks])
  const { textContent, timestamp, responseDurationMs, model, thinkingLevel, account, outputTokens, inputTokens, cachedTokens, costUsd } = footerData

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

  const hasActions = Boolean(textContent || onEditPrompt || onUndo || changedFiles.length > 0)
  if (!hasActions && !timestamp && responseDurationMs === undefined && !model) return null

  const wrapperClass = size === 'roomy' ? 'mt-1 flex min-w-0 flex-wrap items-center gap-1.5' : 'mt-0.5 flex min-w-0 flex-wrap items-center gap-1'
  const hasUsage = outputTokens > 0 || costUsd > 0
  const additions = changedFiles.reduce((sum, file) => sum + file.additions, 0)
  const deletions = changedFiles.reduce((sum, file) => sum + file.deletions, 0)
  const filesLabel = [
    `${changedFiles.length} ${changedFiles.length === 1 ? 'file' : 'files'} changed`,
    additions > 0 && `${additions} ${additions === 1 ? 'line' : 'lines'} added`,
    deletions > 0 && `${deletions} removed`,
  ].filter(Boolean).join(', ')

  const parts: ReactNode[] = []
  // One line: the model ID truncates first (its provider part before its
  // model part); time, duration and cost never wrap.
  if (timestamp) parts.push(<span key="time" className="shrink-0">{formatTime(timestamp)}</span>)
  if (model) parts.push(<ModelName key="model" id={model} data-turn-model />)
  if (account) parts.push(<span key="account" data-turn-account className="min-w-0 max-w-[10rem] truncate">{account}</span>)
  if (responseDurationMs !== undefined) parts.push(<span key="dur" className="shrink-0">{formatMetaDuration(responseDurationMs)}</span>)
  if (hasUsage) {
    parts.push(
      <span key="cost" className="shrink-0">{costUsd > 0 ? formatSpend(costUsd) : `${formatCompact(outputTokens)} tok`}</span>,
    )
  }
  const summary = [
    timestamp && formatTime(timestamp),
    model && (thinkingLevel ? `${model} (thinking ${thinkingLevel})` : model),
    account && `account ${account}`,
    responseDurationMs !== undefined && formatMetaDuration(responseDurationMs),
    hasUsage && (costUsd > 0 ? formatSpend(costUsd) : `${formatInt(outputTokens)} output tokens`),
  ].filter(Boolean).join(', ')
  const cachePercent = inputTokens && cachedTokens !== undefined && inputTokens > 0
    ? Math.round((cachedTokens / inputTokens) * 100)
    : undefined

  return (
    <>
    {/* Open, the row pins to the top of the transcript while a long file list scrolls under it, so it can close from anywhere. */}
    <div className={cn(wrapperClass, filesFold.open && cn(PINNED_HEADER, 'bg-(--bg-page)'))}>
      {hasActions && (
        <div role="group" aria-label="Turn actions" className="flex min-w-0 flex-wrap items-center gap-x-0.5">
          {textContent && (
            <FooterAction
              icon={copied ? Check : Copy}
              iconClassName={copied ? 'text-(--accent-green-text)' : undefined}
              // The name stays put while the tick shows; the tooltip says it.
              label="Copy response"
              hint={copied ? 'Copied' : 'Copy response'}
              onClick={handleCopy}
            />
          )}
          {onEditPrompt && (editLocked ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  // ``aria-disabled``, not ``disabled``: it stays focusable, so the reason shows on keyboard focus too.
                  <button
                    type="button"
                    aria-disabled="true"
                    aria-label="Edit prompt, available when this turn ends"
                    onClick={(event) => event.preventDefault()}
                    className={cn(ACTION_CLASS, 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-(--color-text-muted)')}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                }
              />
              <TooltipContent>Available when this turn ends</TooltipContent>
            </Tooltip>
          ) : (
            <FooterAction icon={Pencil} label="Edit prompt" hint="Edit prompt: undo this turn and put the prompt back in the composer" onClick={onEditPrompt} />
          ))}
          {onUndo && (
            <FooterAction icon={Undo2} label="Undo" hint="Undo this turn. The prompt returns to the composer" onClick={onUndo} />
          )}
          {changedFiles.length > 0 && (
            <button
              ref={filesFold.anchorRef}
              type="button"
              aria-expanded={filesFold.open}
              aria-controls={filesId}
              aria-label={filesLabel}
              onClick={(event) => (filesFold.open ? filesFold.close(event.currentTarget) : filesFold.setOpen(true))}
              className={FILES_CLASS}
            >
              <FileDiff size={13} aria-hidden="true" />
              <span className="font-mono tabular-nums">{changedFiles.length}</span>
              {(additions > 0 || deletions > 0) && (
                <span className="flex items-center gap-1 font-mono tabular-nums">
                  {additions > 0 && <span className="text-(--color-diff-add-text)">+{additions}</span>}
                  {deletions > 0 && <span className="text-(--color-diff-del-text)">-{deletions}</span>}
                </span>
              )}
            </button>
          )}
        </div>
      )}
      {parts.length > 0 && (
        <Popover>
          <PopoverTrigger
            aria-label={`Turn details: ${summary}`}
            aria-haspopup="dialog"
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-sm px-1 font-mono text-meta tabular-nums text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-9"
          >
            {parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`sep-${i}`} aria-hidden className="shrink-0 opacity-60">·</span>, part]))}
          </PopoverTrigger>
          <PopoverContent align="start" side="top" role="dialog" aria-label="Turn details" className="w-[min(20rem,calc(100vw-1rem))]">
            <dl className="flex flex-col gap-1.5">
              {timestamp && <DetailRow label="Finished">{formatFullDateTime(timestamp)}</DetailRow>}
              {model && <DetailRow label="Model"><span title={model}>{model}</span></DetailRow>}
              {thinkingLevel && <DetailRow label="Thinking">{thinkingLevel}</DetailRow>}
              {account && <DetailRow label="Account">{account}</DetailRow>}
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
              className="self-start rounded-sm text-xs font-medium text-(--accent-blue-text) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-9"
            >
              Open session in Usage
            </button>
          </PopoverContent>
        </Popover>
      )}
    </div>
    {changedFiles.length > 0 && (
      <Collapsible open={filesFold.open}>
        <TurnFileList id={filesId} files={changedFiles} />
      </Collapsible>
    )}
    </>
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
  /** The prompt this turn answers, so its footer can offer Edit prompt. */
  promptId?: string
  /** Rewind to a prompt and put it back in the composer (the same flow as editing it in its bubble). */
  onEditPrompt?: (promptId: string) => void
  /** A turn is running, so a prompt cannot be edited yet. */
  editLocked?: boolean
  /** Undo this turn; passed to the last finished turn only. */
  onUndo?: () => void
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
  promptId,
  onEditPrompt,
  editLocked = false,
  onUndo,
}: AssistantTurnProps) {
  // The footer reports on a *finished* turn, so it waits for the turn to close
  // rather than merely for the stream to stop.
  const turnIsOpen = isTurnOpen && isTrailingTurn
  // Narrower: an open turn waiting on ``ask_user`` is not being worked on.
  const turnIsWorking = isWorking && isTrailingTurn
  const awaitsUser = useQuestionAwaitsUser()
  const segments = useMemo(() => (reader ? readerSegments(blocks, awaitsUser) : null), [reader, blocks, awaitsUser])
  // Both transcript styles list the files a finished turn edited.
  const changedFiles = useMemo(() => (turnIsOpen ? NO_FILES : turnChangedFiles(blocks)), [turnIsOpen, blocks])
  const editPrompt = useCallback(() => {
    if (promptId !== undefined) onEditPrompt?.(promptId)
  }, [onEditPrompt, promptId])
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
      {!turnIsOpen && (
        <AssistantTurnFooter
          turnBlocks={blocks}
          size={size}
          changedFiles={changedFiles}
          onEditPrompt={promptId !== undefined && onEditPrompt ? editPrompt : undefined}
          editLocked={editLocked}
          onUndo={onUndo}
        />
      )}
    </div>
  )
})
