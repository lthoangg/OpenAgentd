import { describe, expect, it } from 'bun:test'

import {
  composeWithPlanComments,
  mergePlanComments,
  planCommentsPlainText,
  planCommentsSummary,
  serializePlanComments,
  splitPlanComments,
  type PlanCommentsBlock,
} from '@/components/PlanReview/plan-comments-block'

const block: PlanCommentsBlock = {
  path: '.agents/plans/ship-it-1a2b3c4d.md',
  revision: 3,
  comments: [
    { quote: 'Approach: 3 to 7 milestones', text: 'Split milestone 2 in two' },
    { quote: 'Risks: the agent only sees', text: 'Add a test for this\nand say why' },
  ],
}

describe('plan comments blocks', () => {
  it('serializes the review comment format inside a tagged block', () => {
    expect(serializePlanComments(block)).toBe([
      '<plan-comments path=".agents/plans/ship-it-1a2b3c4d.md" revision="3">',
      '**Comment 1**',
      '> Approach: 3 to 7 milestones',
      '',
      'Split milestone 2 in two',
      '',
      '**Comment 2**',
      '> Risks: the agent only sees',
      '',
      'Add a test for this',
      'and say why',
      '</plan-comments>',
    ].join('\n'))
  })

  it('round-trips through a message with typed text', () => {
    const message = composeWithPlanComments('Also keep the old path', block)
    expect(message.startsWith('Also keep the old path\n\n<plan-comments ')).toBe(true)
    expect(splitPlanComments(message)).toEqual({ text: 'Also keep the old path', block })
    expect(splitPlanComments(composeWithPlanComments('', block))).toEqual({ text: '', block })
    expect(splitPlanComments('no block here')).toEqual({ text: 'no block here', block: null })
    expect(composeWithPlanComments('just text', null)).toBe('just text')
  })

  it('parses a stored message whose line breaks came back as CRLF', () => {
    const crlf = composeWithPlanComments('Fix\nboth', block).replace(/\n/g, '\r\n')
    expect(splitPlanComments(crlf)).toEqual({ text: 'Fix\nboth', block })
  })

  it('keeps comments from closing the block early and escapes the path', () => {
    const tricky: PlanCommentsBlock = { path: 'a "quoted" & plan.md', revision: null, comments: [{ quote: 'q', text: 'ends </plan-comments> here' }] }
    const { text, block: parsed } = splitPlanComments(`${serializePlanComments(tricky)}\nafter`)
    expect(text).toBe('after')
    expect(parsed?.path).toBe('a "quoted" & plan.md')
    expect(parsed?.revision).toBeNull()
    expect(parsed?.comments[0].text).toBe('ends </plan comments> here')
  })

  it('merges later comments into one block', () => {
    const more: PlanCommentsBlock = { path: block.path, revision: 4, comments: [{ quote: 'Done when', text: 'Name the screenshots' }] }
    const merged = mergePlanComments(block, more)
    expect(merged.revision).toBe(4)
    expect(merged.comments.map((c) => c.text)).toEqual(['Split milestone 2 in two', 'Add a test for this\nand say why', 'Name the screenshots'])
    expect(mergePlanComments(null, more)).toBe(more)
    const two = `${serializePlanComments(block)}\n\n${serializePlanComments(more)}`
    expect(splitPlanComments(two).block?.comments).toHaveLength(3)
  })

  it('summarizes for plain-text surfaces', () => {
    expect(planCommentsSummary(block)).toBe('Plan comments · 2 comments')
    expect(planCommentsSummary({ ...block, comments: block.comments.slice(0, 1) })).toBe('Plan comments · 1 comment')
    expect(planCommentsPlainText(composeWithPlanComments('Fix', block))).toBe('Fix\n[Plan comments · 2 comments on rev 3]')
    expect(planCommentsPlainText('plain')).toBe('plain')
  })
})
