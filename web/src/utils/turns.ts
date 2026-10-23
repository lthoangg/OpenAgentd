/**
 * Turn partitioning for assistant chat streams.
 *
 * A "turn" is a contiguous run of non-user blocks (thinking / tool / text).
 * User blocks are their own items. Used to render one footer (copy + time)
 * per assistant turn, regardless of how many internal blocks the turn has.
 *
 * With ``foldAgentReports`` (reader mode), a message another agent sent, such
 * as a subagent's report, that arrives after the agent's work joins that turn
 * as one more step instead of starting a new one. An agent's message that
 * opens a turn (e.g. a lead's task for a member) stays its prompt.
 *
 * A forced compaction (``/compact`` or idle compaction, ``extra.forced``)
 * that ends a turn is an item of its own, so the reply before it keeps its
 * footer. One that lands inside a turn (a reloaded summary is anchored before
 * the replies it kept) stays a step of that turn, as an auto-compaction is.
 */
import type { ContentBlock } from '@/api/types'

export type TurnItem =
  | { kind: 'user'; block: ContentBlock; index: number }
  | { kind: 'assistant'; blocks: ContentBlock[]; startIndex: number }
  | { kind: 'compaction'; block: ContentBlock; index: number }

export interface PartitionOptions {
  /** Fold agent-sent messages that follow the agent's work into its turn. */
  foldAgentReports?: boolean
}

/** A message another agent sent into this session, e.g. a subagent's report. */
export function isAgentReport(block: ContentBlock): boolean {
  const fromAgent = block.extra?.from_agent
  return block.type === 'user' && typeof fromAgent === 'string' && fromAgent !== '' && fromAgent !== 'user'
}

export interface VisibleTurnWindow {
  hiddenTurnCount: number
  visibleTurnItems: TurnItem[]
}

export function getVisibleTurnWindow(
  turnItems: TurnItem[],
  renderedTurnCount: number,
): VisibleTurnWindow {
  const hiddenTurnCount = Math.max(0, turnItems.length - renderedTurnCount)
  return {
    hiddenTurnCount,
    visibleTurnItems: hiddenTurnCount > 0 ? turnItems.slice(hiddenTurnCount) : turnItems,
  }
}

/** ``blocks[index]`` is a forced compaction that ends its turn: only compactions follow it before a user block or the end. */
function isStandaloneCompaction(blocks: ContentBlock[], index: number): boolean {
  const block = blocks[index]
  if (block.type !== 'compaction' || block.extra?.forced !== true) return false
  for (let i = index + 1; i < blocks.length; i++) {
    if (blocks[i].type === 'compaction') continue
    return blocks[i].type === 'user'
  }
  return true
}

/** ``continuesTurn``: ``blocks`` pick up after an assistant turn, so a leading report folds into it. */
function partition(blocks: ContentBlock[], foldAgentReports: boolean, continuesTurn: boolean): TurnItem[] {
  const items: TurnItem[] = []
  let turn: ContentBlock[] | null = null
  let followsWork = continuesTurn
  blocks.forEach((block, index) => {
    if (isStandaloneCompaction(blocks, index)) {
      items.push({ kind: 'compaction', block, index })
      turn = null
      followsWork = false
      return
    }
    const joinsTurn = block.type !== 'user' || (foldAgentReports && followsWork && isAgentReport(block))
    if (!joinsTurn) {
      items.push({ kind: 'user', block, index })
      turn = null
      followsWork = false
      return
    }
    if (!turn) {
      turn = []
      items.push({ kind: 'assistant', blocks: turn, startIndex: index })
    }
    turn.push(block)
    followsWork = true
  })
  return items
}

export function partitionTurns(blocks: ContentBlock[], options: PartitionOptions = {}): TurnItem[] {
  return partition(blocks, options.foldAgentReports ?? false, false)
}

/**
 * The model that produced a turn, with the thinking level it ran at: read
 * together from the newest block that names a model.
 */
export function turnModel(blocks: ContentBlock[]): { model: string; thinkingLevel?: string } | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const extra = blocks[i].extra
    if (typeof extra?.model !== 'string') continue
    const level = extra.thinking_level
    return { model: extra.model, thinkingLevel: typeof level === 'string' && level ? level : undefined }
  }
  return undefined
}

/**
 * The model and thinking level of each prompt, keyed by block id: the ones
 * that answered it, or, before an answer names one, the ones it was sent
 * with.
 */
export function promptModels(items: TurnItem[]): Map<string, { model: string; thinkingLevel?: string }> {
  const models = new Map<string, { model: string; thinkingLevel?: string }>()
  items.forEach((item, i) => {
    if (item.kind !== 'user') return
    const next = items[i + 1]
    const model = (next?.kind === 'assistant' ? turnModel(next.blocks) : undefined) ?? turnModel([item.block])
    if (model) models.set(item.block.id, model)
  })
  return models
}

/**
 * Add a live suffix to already-partitioned, finalized history. Streaming
 * replaces `currentBlocks` on every delta, so re-partitioning the combined
 * array would otherwise walk the entire session for each token.
 */
export function appendCurrentTurns(
  finalizedTurns: TurnItem[],
  finalizedBlockCount: number,
  currentBlocks: ContentBlock[],
  options: PartitionOptions = {},
): TurnItem[] {
  if (currentBlocks.length === 0) return finalizedTurns

  const lastFinalized = finalizedTurns[finalizedTurns.length - 1]
  const currentTurns = partition(currentBlocks, options.foldAgentReports ?? false, lastFinalized?.kind === 'assistant').map((item) => (
    item.kind === 'assistant'
      ? { ...item, startIndex: item.startIndex + finalizedBlockCount }
      : { ...item, index: item.index + finalizedBlockCount }
  ))
  const firstCurrent = currentTurns[0]

  if (lastFinalized?.kind === 'assistant' && firstCurrent?.kind === 'assistant') {
    return [
      ...finalizedTurns.slice(0, -1),
      { ...lastFinalized, blocks: [...lastFinalized.blocks, ...firstCurrent.blocks] },
      ...currentTurns.slice(1),
    ]
  }

  return [...finalizedTurns, ...currentTurns]
}
