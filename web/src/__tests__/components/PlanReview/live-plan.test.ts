/**
 * live-plan — the plan as the lead's running ``plan`` call would leave it,
 * built from the call's partial JSON arguments so the Plan tab can show the
 * plan being written in place.
 */
import { describe, expect, it } from 'bun:test'
import type { ContentBlock } from '@/api/types'
import { livePlanContent, parsePartialObject, selectLivePlanBlock } from '@/components/PlanReview/live-plan'

describe('parsePartialObject', () => {
  it('reads a complete object as-is', () => {
    expect(parsePartialObject('{"action":"write","content":"# A"}')).toEqual({ action: 'write', content: '# A' })
  })

  it('keeps a value string that is still streaming, escapes decoded', () => {
    expect(parsePartialObject('{"action":"write","content":"# Ship\\n\\n1. Wr')).toEqual({
      action: 'write',
      content: '# Ship\n\n1. Wr',
    })
  })

  it('drops an escape cut in half instead of showing it raw', () => {
    expect(parsePartialObject('{"content":"a\\')).toEqual({ content: 'a' })
    expect(parsePartialObject('{"content":"a\\u00')).toEqual({ content: 'a' })
  })

  it('ends a string at an escaped backslash before the closing quote', () => {
    expect(parsePartialObject('{"content":"C:\\\\","action":"wri')).toEqual({ content: 'C:\\', action: 'wri' })
  })

  it('drops a key that has no value yet', () => {
    expect(parsePartialObject('{"action":"write","con')).toEqual({ action: 'write' })
    expect(parsePartialObject('{"action":"write","content":')).toEqual({ action: 'write' })
    expect(parsePartialObject('{"action":"write",')).toEqual({ action: 'write' })
  })

  it('closes nested arrays and objects', () => {
    expect(parsePartialObject('{"action":"edit","edits":[{"old":"a","new":"b"},{"old":"c')).toEqual({
      action: 'edit',
      edits: [{ old: 'a', new: 'b' }, { old: 'c' }],
    })
    expect(parsePartialObject('{"action":"edit","edits":[')).toEqual({ action: 'edit', edits: [] })
  })

  it('returns null for anything that is not an object', () => {
    expect(parsePartialObject('')).toBeNull()
    expect(parsePartialObject('[1,2')).toBeNull()
  })
})

describe('livePlanContent', () => {
  const BASE = '# Plan\n\n1. Old step\n2. Keep'

  it('shows a write as its content so far', () => {
    expect(livePlanContent('{"action":"write","content":"# New\\n\\n1. Fir', BASE)).toEqual({ action: 'write', content: '# New\n\n1. Fir' })
  })

  it('keeps the current plan until a write has content', () => {
    expect(livePlanContent('{"action":"write","content":"', BASE)).toEqual({ action: 'write', content: null })
    expect(livePlanContent('{"act', BASE)).toEqual({ action: null, content: null })
  })

  it('applies each edit in place, the streaming one with its partial new text', () => {
    const args = '{"action":"edit","edits":[{"old":"1. Old step","new":"1. New step"},{"old":"2. Keep","new":"2. Ke'
    expect(livePlanContent(args, BASE)).toEqual({ action: 'edit', content: '# Plan\n\n1. New step\n2. Ke' })
  })

  it('waits for an edit whose old text is still streaming', () => {
    const args = '{"action":"edit","edits":[{"old":"1. Old st'
    expect(livePlanContent(args, BASE)).toEqual({ action: 'edit', content: BASE })
  })

  it('stops at an edit the server would reject, as it applies them in order', () => {
    const args = JSON.stringify({ action: 'edit', edits: [{ old: 'missing', new: 'x' }, { old: '2. Keep', new: '2. Done' }] })
    expect(livePlanContent(args, BASE)).toEqual({ action: 'edit', content: BASE })
  })

  it('inserts replacement text literally', () => {
    const args = JSON.stringify({ action: 'edit', edits: [{ old: '2. Keep', new: '2. Cost $& $1' }] })
    expect(livePlanContent(args, BASE).content).toBe('# Plan\n\n1. Old step\n2. Cost $& $1')
  })
})

describe('selectLivePlanBlock', () => {
  const tool = (id: string, toolName: string, extra: Partial<ContentBlock> = {}): ContentBlock => ({
    id, type: 'tool', content: '', toolName, toolCallId: id, toolArgs: '{}', ...extra,
  })
  const state = (blocks: ContentBlock[], sessionId = 's-1') => ({
    sessionId,
    leadName: 'lead',
    agentStreams: { lead: { currentBlocks: blocks }, member: { currentBlocks: [tool('m', 'plan')] } },
  })

  it("picks the lead's newest plan call in the current turn", () => {
    const blocks = [tool('p1', 'plan', { toolDone: true }), tool('s', 'shell'), tool('p2', 'plan')]
    expect(selectLivePlanBlock(state(blocks), 's-1')?.id).toBe('p2')
  })

  it('is null for another session or a turn without a plan call', () => {
    expect(selectLivePlanBlock(state([tool('p', 'plan')]), 's-2')).toBeNull()
    expect(selectLivePlanBlock(state([tool('s', 'shell')]), 's-1')).toBeNull()
  })
})
