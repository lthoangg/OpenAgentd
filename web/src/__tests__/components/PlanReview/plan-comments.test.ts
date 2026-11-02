import { afterEach, describe, expect, it } from 'bun:test'
import { createElement, Fragment } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  clearPlanReviewDrafts,
  findTextRange,
  formatPlanReview,
  overlayLeft,
  parsePlanReview,
  planReviewAnswer,
  quoteExcerpt,
  readPlanReviewDraft,
  snapshotPlanReviewDraft,
  usePlanReviewDraft,
  writePlanReviewDraft,
  forgetPlanReviewDraft,
} from '@/components/PlanReview/plan-comments'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  clearPlanReviewDrafts()
})

describe('formatPlanReview', () => {
  it('numbers each comment under its quoted passage and puts overall feedback last', () => {
    const text = formatPlanReview(
      [
        { quote: 'Step A', text: 'Split this.' },
        { quote: 'Line one\n\n\nLine two', text: '  Needs a test.  ' },
      ],
      ' Looks good otherwise. ',
    )
    expect(text).toBe(
      '**Comment 1**\n> Step A\n\nSplit this.\n\n' +
        '**Comment 2**\n> Line one\n> Line two\n\nNeeds a test.\n\n' +
        '**Overall**\nLooks good otherwise.',
    )
  })

  it('sends plain feedback as it is when there are no comments', () => {
    expect(formatPlanReview([], '  Use a flag instead.  ')).toBe('Use a flag instead.')
    expect(formatPlanReview([], '')).toBe('')
  })

  it('skips comments without text', () => {
    expect(formatPlanReview([{ quote: 'Step A', text: '  ' }], 'Only this')).toBe('Only this')
  })

  it('cuts long passages; the agent has the full plan', () => {
    const quote = quoteExcerpt('x'.repeat(1000))
    expect(quote.length).toBe(300)
    expect(quote.endsWith('…')).toBe(true)
  })
})

describe('parsePlanReview', () => {
  it('reads back what formatPlanReview wrote', () => {
    const comments = [
      { quote: 'Step A', text: 'Split this.\nInto two.' },
      { quote: 'Line one\nLine two', text: 'Needs a test.' },
    ]
    expect(parsePlanReview(formatPlanReview(comments, 'Overall note'))).toEqual({ comments, overall: 'Overall note' })
  })

  it('reads plain feedback as overall feedback', () => {
    expect(parsePlanReview('Use a flag instead.')).toEqual({ comments: [], overall: 'Use a flag instead.' })
  })

  it('reads the earlier form, where comments followed quotes in one box', () => {
    expect(parsePlanReview('> Step A\n\nSplit this.\n\n> Step B\n\nDrop it.')).toEqual({
      comments: [
        { quote: 'Step A', text: 'Split this.' },
        { quote: 'Step B', text: 'Drop it.' },
      ],
      overall: '',
    })
  })
})

describe('findTextRange', () => {
  it('finds a passage across blocks, whatever the whitespace', () => {
    document.body.innerHTML = '<div id="plan"><ul><li>Write the migration</li><li>Wire the endpoint</li></ul></div>'
    const range = findTextRange(document.getElementById('plan')!, 'the migration\nWire the')
    expect(range?.toString()).toBe('the migrationWire the')
  })

  it('ignores the comment overlays and returns null when the plan lacks the passage', () => {
    document.body.innerHTML = '<div id="plan"><p>Step A</p><div data-plan-overlay>Comment</div></div>'
    const plan = document.getElementById('plan')!
    expect(findTextRange(plan, 'Comment')).toBeNull()
    expect(findTextRange(plan, 'Step B')).toBeNull()
  })
})

describe('overlayLeft', () => {
  it('centres an overlay under the selection end and keeps it inside the plan', () => {
    expect(overlayLeft({ text: 'x', top: 0, left: 200, width: 600 }, 100)).toBe(150)
    expect(overlayLeft({ text: 'x', top: 0, left: 10, width: 600 }, 100)).toBe(8)
    expect(overlayLeft({ text: 'x', top: 0, left: 590, width: 600 }, 100)).toBe(492)
  })
})

describe('review drafts', () => {
  it('keeps a draft per review and drops empty ones', () => {
    writePlanReviewDraft('q-1', { comments: [{ id: 'c1', quote: 'A', text: 'B' }], overall: '' })
    expect(readPlanReviewDraft('q-1').comments).toHaveLength(1)
    expect(readPlanReviewDraft('q-2')).toEqual({ comments: [], overall: '' })
    writePlanReviewDraft('q-1', { comments: [], overall: '' })
    expect(readPlanReviewDraft('q-1')).toEqual({ comments: [], overall: '' })
  })

  it('hands the same empty draft to every review with nothing written, so a subscriber never loops', () => {
    expect(snapshotPlanReviewDraft('q-1')).toBe(snapshotPlanReviewDraft('q-2'))
    expect(snapshotPlanReviewDraft(null)).toBe(snapshotPlanReviewDraft('q-1'))
    const draft = { comments: [{ id: 'c1', quote: 'A', text: 'B' }], overall: '' }
    writePlanReviewDraft('q-1', draft)
    expect(snapshotPlanReviewDraft('q-1')).toBe(draft)
    expect(snapshotPlanReviewDraft('q-1')).toBe(snapshotPlanReviewDraft('q-1'))
  })

  it('tells every reader of a review when its draft changes: the Plan tab and the card share one', () => {
    function Reader({ label }: { label: string }) {
      const draft = usePlanReviewDraft('q-1')
      return createElement('p', { 'aria-label': label }, `${draft.comments.length}|${draft.overall}`)
    }
    render(createElement(Fragment, null, createElement(Reader, { label: 'tab' }), createElement(Reader, { label: 'card' })))
    expect(screen.getByLabelText('tab').textContent).toBe('0|')

    act(() => {
      writePlanReviewDraft('q-1', { comments: [{ id: 'c1', quote: 'A', text: 'B' }], overall: 'Overall.' })
    })
    expect(screen.getByLabelText('tab').textContent).toBe('1|Overall.')
    expect(screen.getByLabelText('card').textContent).toBe('1|Overall.')

    act(() => forgetPlanReviewDraft('q-1'))
    expect(screen.getByLabelText('card').textContent).toBe('0|')
  })

  it('does not wake readers of another review', () => {
    function Reader() {
      const draft = usePlanReviewDraft('q-2')
      return createElement('p', { 'aria-label': 'other' }, draft.overall)
    }
    render(createElement(Reader))

    act(() => {
      writePlanReviewDraft('q-1', { comments: [], overall: 'Not yours.' })
    })

    expect(screen.getByLabelText('other').textContent).toBe('')
  })
})

describe('planReviewAnswer', () => {
  it('formats comments, a half-written comment and the overall feedback as one answer', () => {
    expect(
      planReviewAnswer({
        comments: [{ id: 'c1', quote: 'Step A', text: 'Split this.' }],
        overall: 'Otherwise fine.',
        composer: { quote: 'Step B', text: 'Add a test.' },
      }),
    ).toBe('**Comment 1**\n> Step A\n\nSplit this.\n\n**Comment 2**\n> Step B\n\nAdd a test.\n\n**Overall**\nOtherwise fine.')
  })

  it('leaves out a comment box nothing was typed in, and is empty for an empty draft', () => {
    expect(planReviewAnswer({ comments: [], overall: '', composer: { quote: 'Step B', text: '  ' } })).toBe('')
    expect(planReviewAnswer(snapshotPlanReviewDraft('q-9'))).toBe('')
  })
})
