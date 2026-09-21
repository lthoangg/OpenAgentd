import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

import { TranscriptFind } from '@/components/AgentView/TranscriptFind'

afterEach(cleanup)

describe('TranscriptFind', () => {
  it('focuses the query field on open', () => {
    render(
      <TranscriptFind
        query="alpha"
        matchCount={3}
        activeIndex={0}
        onQueryChange={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('searchbox', { name: 'Find in transcript' })).toHaveFocus()
  })

  it('shows the current match count', () => {
    render(
      <TranscriptFind
        query="alpha"
        matchCount={3}
        activeIndex={1}
        onQueryChange={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('2/3')).toBeInTheDocument()
  })

  it('shows no matches for a non-empty query with zero hits', () => {
    render(
      <TranscriptFind
        query="zzz"
        matchCount={0}
        activeIndex={0}
        onQueryChange={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('No matches')).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    let closed = false
    const onClose = () => { closed = true }
    render(
      <TranscriptFind
        query="alpha"
        matchCount={1}
        activeIndex={0}
        onQueryChange={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={onClose}
      />,
    )
    await user.keyboard('{Escape}')
    expect(closed).toBe(true)
  })

  it('cycles with Enter and Shift+Enter', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    render(
      <TranscriptFind
        query="alpha"
        matchCount={3}
        activeIndex={0}
        onQueryChange={() => {}}
        onNext={() => { calls.push('next') }}
        onPrev={() => { calls.push('prev') }}
        onClose={() => {}}
      />,
    )
    await user.keyboard('{Enter}')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(calls).toEqual(['next', 'prev'])
  })
})
