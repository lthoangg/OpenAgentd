import { describe, expect, it } from 'bun:test'
import {
  applyTranscriptFindHighlight,
  clearTranscriptFindHighlight,
} from '@/components/AgentView/transcript-find-highlight'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe('applyTranscriptFindHighlight', () => {
  it('wraps only the matched substring, not the whole block', () => {
    const root = mount('<div data-find-block="u1">Hello world</div>')
    applyTranscriptFindHighlight(root, 'HELLO', 0)
    const mark = root.querySelector('mark[data-transcript-find]')
    expect(mark?.textContent).toBe('Hello')
    expect(root.textContent).toBe('Hello world')
    expect(mark?.hasAttribute('data-transcript-find-active')).toBe(true)
    clearTranscriptFindHighlight(root)
    root.remove()
  })

  it('marks the active occurrence among several matches', () => {
    const root = mount(
      '<div data-find-block="a1">foo bar foo</div><div data-find-block="a2">foo</div>',
    )
    applyTranscriptFindHighlight(root, 'foo', 1)
    const marks = [...root.querySelectorAll('mark[data-transcript-find]')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['foo', 'foo', 'foo'])
    expect(marks[1]?.hasAttribute('data-transcript-find-active')).toBe(true)
    expect(marks[0]?.hasAttribute('data-transcript-find-active')).toBe(false)
    clearTranscriptFindHighlight(root)
    root.remove()
  })

  it('does not search unmarked nodes', () => {
    const root = mount('<div data-tool="t1">secret-token</div>')
    applyTranscriptFindHighlight(root, 'secret', 0)
    expect(root.querySelector('mark')).toBeNull()
    root.remove()
  })
})
