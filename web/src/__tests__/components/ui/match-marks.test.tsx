import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

import { MatchMarks, matchRanges } from '@/components/ui/match-marks'

afterEach(cleanup)

describe('matchRanges', () => {
  it('finds every word wherever it occurs, whatever its case', () => {
    expect(matchRanges('Auth then auth', ['auth'])).toEqual([[0, 4], [10, 14]])
  })

  it('merges words that overlap or touch into one range', () => {
    expect(matchRanges('New session', ['ne', 'new', 'ses'])).toEqual([[0, 3], [4, 7]])
    expect(matchRanges('abcdef', ['abc', 'def'])).toEqual([[0, 6]])
  })

  it('marks nothing when a case fold would change the length', () => {
    expect(matchRanges('İstanbul', ['i'])).toEqual([])
  })
})

describe('MatchMarks', () => {
  it('marks the matches it draws, and is read as the plain text', () => {
    const { container } = render(<MatchMarks text="Fix flaky auth test" words={['auth']} />)

    const drawn = container.querySelector('[aria-hidden="true"]')!
    expect(Array.from(drawn.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['auth'])
    expect(drawn.textContent).toBe('Fix flaky auth test')
    expect(container.querySelector('.sr-only')?.textContent).toBe('Fix flaky auth test')
  })

  it('is the plain text alone when nothing matches', () => {
    const { container } = render(<MatchMarks text="Rotate tokens" words={['auth']} />)
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe('Rotate tokens')
  })
})
