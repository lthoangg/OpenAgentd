/**
 * Turn partitioning for assistant chat streams.
 *
 * A "turn" is a contiguous run of non-user blocks (thinking / tool / text).
 * User blocks are their own items. Used to render one footer (copy + time)
 * per assistant turn, regardless of how many internal blocks the turn has.
 */
import type { ContentBlock } from '@/api/types'

export type TurnItem =
  | { kind: 'user'; block: ContentBlock; index: number }
  | { kind: 'assistant'; blocks: ContentBlock[]; startIndex: number }

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

export function partitionTurns(blocks: ContentBlock[]): TurnItem[] {
  const items: TurnItem[] = []
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]
    if (b.type === 'user') {
      items.push({ kind: 'user', block: b, index: i })
      i++
      continue
    }
    const startIndex = i
    const turnBlocks: ContentBlock[] = []
    while (i < blocks.length && blocks[i].type !== 'user') {
      turnBlocks.push(blocks[i])
      i++
    }
    items.push({ kind: 'assistant', blocks: turnBlocks, startIndex })
  }
  return items
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
): TurnItem[] {
  if (currentBlocks.length === 0) return finalizedTurns

  const currentTurns = partitionTurns(currentBlocks).map((item) => (
    item.kind === 'user'
      ? { ...item, index: item.index + finalizedBlockCount }
      : { ...item, startIndex: item.startIndex + finalizedBlockCount }
  ))
  const lastFinalized = finalizedTurns[finalizedTurns.length - 1]
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
