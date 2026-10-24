/**
 * Prompt navigation: which prompt a previous/next jump lands on, over the
 * rendered transcript, and over the loaded turns when it is not rendered.
 *
 * Positions are prompt tops in px from the transcript's top edge, in
 * transcript order, so the rules stay testable without layout.
 */
import { isTypedPromptBlock } from '@/stores/useAgentStore/helpers'
import type { TurnItem } from '@/utils/turns'

/** Where a prompt lands, below the transcript's top edge, after a jump. */
export const PROMPT_JUMP_MARGIN = 12

/** Slack for sub-pixel layout, so a prompt already on the line counts as there. */
const EPSILON = 2

/**
 * The turn holding block ``id``; -1 when it is not loaded. By block rather
 * than by turn, because an older page can end inside a turn and merge into it.
 */
export function turnIndexOfBlock(items: readonly TurnItem[], id: string): number {
  return items.findIndex((item) => (item.kind === 'assistant' ? item.blocks.some((b) => b.id === id) : item.block.id === id))
}

/** The nearest turn before ``before`` that is a prompt the user wrote; -1 when none is loaded. */
export function previousPromptTurn(items: readonly TurnItem[], before: number): number {
  for (let i = Math.min(before, items.length) - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'user' && isTypedPromptBlock(item.block)) return i
  }
  return -1
}

/** Rendered prompts the user wrote, in transcript order. */
export function promptElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-prompt-id]'))
}

/** The nearest prompt strictly above (``-1``) or below (``1``) ``line``; -1 when there is none. */
export function promptJumpTarget(tops: readonly number[], line: number, direction: -1 | 1): number {
  if (direction < 0) {
    for (let i = tops.length - 1; i >= 0; i--) if (tops[i] < line - EPSILON) return i
    return -1
  }
  for (let i = 0; i < tops.length; i++) if (tops[i] > line + EPSILON) return i
  return -1
}
