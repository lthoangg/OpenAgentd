/**
 * Which blocks of the rendered plan get a Comment action, and what each one
 * quotes: the block's own text, never the action's, and never a nested list's.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { blockText, commentableBlocks } from '@/components/PlanReview/PlanBlockComments'

afterEach(() => {
  document.body.innerHTML = ''
})

function plan(html: string): HTMLElement {
  document.body.innerHTML = `<div id="plan">${html}</div>`
  return document.getElementById('plan') as HTMLElement
}

describe('blockText', () => {
  it('collapses whitespace and leaves out the overlay slot', () => {
    const root = plan('<p>Write   the\n migration<span data-plan-overlay>Comment</span></p>')
    expect(blockText(root.querySelector('p') as HTMLElement)).toBe('Write the migration')
  })

  it('keeps a list item to its own text, not its nested list', () => {
    const root = plan('<ul><li>Two<ul><li>Nested</li></ul></li></ul>')
    const [outer, inner] = Array.from(root.querySelectorAll('li'))
    expect(blockText(outer as HTMLElement)).toBe('Two')
    expect(blockText(inner as HTMLElement)).toBe('Nested')
  })

  it('reads inline markup as the text it renders', () => {
    const root = plan('<p>Run <code>bun test</code> and <strong>fix</strong> it.</p>')
    expect(blockText(root.querySelector('p') as HTMLElement)).toBe('Run bun test and fix it.')
  })
})

describe('commentableBlocks', () => {
  it('takes headings, paragraphs and list items, in document order', () => {
    const root = plan('<h2>Steps</h2><p>Intro.</p><ol><li>One</li><li>Two</li></ol>')
    expect(commentableBlocks(root).map((el) => el.tagName)).toEqual(['H2', 'P', 'LI', 'LI'])
  })

  it('leaves a list item to the paragraphs it wraps (a loose list)', () => {
    const root = plan('<ul><li><p>First</p></li><li><p>Second</p></li></ul>')
    expect(commentableBlocks(root).map((el) => el.textContent)).toEqual(['First', 'Second'])
  })

  it('skips tables, code and empty blocks', () => {
    const root = plan('<table><tbody><tr><td><p>cell</p></td></tr></tbody></table><pre><code>let x</code></pre><p> </p><p>Real</p>')
    expect(commentableBlocks(root).map((el) => el.textContent)).toEqual(['Real'])
  })

  it('never takes the overlay itself', () => {
    const root = plan('<ul><li>Text<div data-plan-overlay><p>inside the slot</p></div></li></ul>')
    expect(commentableBlocks(root).map((el) => blockText(el))).toEqual(['Text'])
  })
})
