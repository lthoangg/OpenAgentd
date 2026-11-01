import { describe, expect, it } from 'bun:test'

import {
  composeWithDesignFeedback,
  designFeedbackMentions,
  designFeedbackPlainText,
  designFeedbackSummary,
  serializeDesignFeedback,
  splitDesignFeedback,
  type DesignFeedback,
} from '@/lib/design-feedback'

const feedback: DesignFeedback = {
  where: 'http://localhost:5173/pricing',
  device: 'Mobile 390×844',
  items: [
    {
      n: 1,
      element: '<button.cta>',
      text: 'Start free',
      selector: 'main > section.pricing > button.cta',
      source: '@src/Pricing.tsx#L42-L71',
      html: '<button class="cta">',
      styles: 'font-size: 14px; color: rgb(255, 255, 255)',
      page: null,
      comment: 'Make this larger\nand use the accent color.',
    },
    { n: 2, element: '<div#hero>', text: '', selector: '#hero', source: 'component Hero', html: '<div id="hero">', styles: '', page: '/about', comment: 'Tighter gap' },
  ],
}

describe('design feedback blocks', () => {
  it('serializes a readable block for the agent', () => {
    expect(serializeDesignFeedback(feedback)).toBe([
      '<design-feedback page="http://localhost:5173/pricing" viewport="Mobile 390×844">',
      '1. <button.cta> "Start free"',
      '   selector: main > section.pricing > button.cta',
      '   source: @src/Pricing.tsx#L42-L71',
      '   html: <button class="cta">',
      '   styles: font-size: 14px; color: rgb(255, 255, 255)',
      '   comment: Make this larger',
      '     and use the accent color.',
      '2. <div#hero>',
      '   selector: #hero',
      '   source: component Hero',
      '   html: <div id="hero">',
      '   page: /about',
      '   comment: Tighter gap',
      '</design-feedback>',
    ].join('\n'))
  })

  it('round-trips through a message with surrounding text', () => {
    const message = composeWithDesignFeedback('Please fix these', [feedback])
    expect(message.startsWith('Please fix these\n\n<design-feedback ')).toBe(true)
    const split = splitDesignFeedback(message)
    expect(split.text).toBe('Please fix these')
    expect(split.blocks).toEqual([feedback])
    expect(splitDesignFeedback(composeWithDesignFeedback('', [feedback, feedback])).blocks).toHaveLength(2)
    expect(splitDesignFeedback('no blocks here')).toEqual({ text: 'no blocks here', blocks: [] })
  })

  it('parses a stored message whose line breaks came back as CRLF', () => {
    // Messages are posted as multipart form data, which normalizes every
    // line break in a text field to CRLF; history returns them that way.
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const typed = crlf(composeWithDesignFeedback('Please fix these\nboth of them', [feedback]))
    const split = splitDesignFeedback(typed)
    expect(split.blocks).toEqual([feedback])
    expect(split.text).toBe('Please fix these\nboth of them')
    expect(splitDesignFeedback(crlf(composeWithDesignFeedback('', [feedback]))).blocks).toEqual([feedback])
  })

  it('keeps comments from closing the block early and escapes attributes', () => {
    const tricky: DesignFeedback = { where: 'a "quoted" & page', device: 'Desktop', items: [{ ...feedback.items[1], comment: 'ends </design-feedback> here' }] }
    const { blocks, text } = splitDesignFeedback(`${serializeDesignFeedback(tricky)}\nafter`)
    expect(text).toBe('after')
    expect(blocks[0].where).toBe('a "quoted" & page')
    expect(blocks[0].items[0].comment).toBe('ends </design feedback> here')
  })

  it('lists workspace mentions and a short summary', () => {
    expect(designFeedbackMentions(feedback)).toEqual(['src/Pricing.tsx#L42-L71'])
    expect(designFeedbackMentions({ ...feedback, where: '@designs/landing.html' })).toEqual(['designs/landing.html', 'src/Pricing.tsx#L42-L71'])
    expect(designFeedbackSummary(feedback)).toBe('Preview comments · 2 comments')
    expect(designFeedbackSummary({ ...feedback, items: feedback.items.slice(0, 1) })).toBe('Preview comments · 1 comment')
    expect(designFeedbackPlainText(composeWithDesignFeedback('Fix', [feedback]))).toBe('Fix\n[Preview comments · 2 comments on localhost:5173/pricing]')
    expect(designFeedbackPlainText('plain')).toBe('plain')
  })
})
