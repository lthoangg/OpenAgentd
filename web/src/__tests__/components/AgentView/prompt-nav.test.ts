import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import { previousPromptTurn, promptJumpTarget, turnIndexOfBlock } from '@/components/AgentView/prompt-nav'
import { partitionTurns } from '@/utils/turns'

// Prompt tops, in px from the transcript's top edge, in transcript order.
const TOPS = [-500, -100, 12, 300]

describe('promptJumpTarget', () => {
  it('steps past a prompt that already sits on the line', () => {
    expect(promptJumpTarget(TOPS, 12, -1)).toBe(1)
    expect(promptJumpTarget(TOPS, 12, 1)).toBe(3)
  })

  it('finds nothing beyond either end', () => {
    expect(promptJumpTarget(TOPS, -600, -1)).toBe(-1)
    expect(promptJumpTarget(TOPS, 400, 1)).toBe(-1)
  })
})

describe('previousPromptTurn', () => {
  const items = partitionTurns([
    { id: 'p1', type: 'user', content: 'first' },
    { id: 'a1', type: 'text', content: 'answer' },
    { id: 'r1', type: 'user', content: 'report', extra: { from_agent: 'explorer' } },
    { id: 'a2', type: 'text', content: 'more' },
    { id: 'p2', type: 'user', content: 'second' },
  ] satisfies ContentBlock[])

  it('is the nearest turn before ``before`` holding a prompt the user wrote, past agent reports', () => {
    expect(previousPromptTurn(items, 4)).toBe(0)
    expect(previousPromptTurn(items, 1)).toBe(0)
  })

  it('is -1 when no earlier prompt is loaded', () => {
    expect(previousPromptTurn(items, 0)).toBe(-1)
    expect(previousPromptTurn(items, -1)).toBe(-1)
  })
})

describe('turnIndexOfBlock', () => {
  it('finds the turn holding a block, even after an older page merged into that turn', () => {
    const tail: ContentBlock[] = [
      { id: 'a2', type: 'text', content: 'the end of a long answer' },
      { id: 'p2', type: 'user', content: 'next' },
    ]
    const merged = partitionTurns([
      { id: 'p1', type: 'user', content: 'first' },
      { id: 'a1', type: 'text', content: 'the start of it' },
      ...tail,
    ] satisfies ContentBlock[])

    expect(turnIndexOfBlock(partitionTurns(tail), 'a2')).toBe(0)
    expect(turnIndexOfBlock(merged, 'a2')).toBe(1)
    expect(turnIndexOfBlock(merged, 'p2')).toBe(2)
    expect(turnIndexOfBlock(merged, 'gone')).toBe(-1)
  })
})
