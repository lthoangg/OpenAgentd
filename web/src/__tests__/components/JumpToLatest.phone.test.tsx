/**
 * On a phone Jump to latest is a round ↓ at the right corner with a count
 * badge (mockup J4).
 */
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { JumpToLatest } = await import('@/components/JumpToLatestChip')

afterEach(cleanup)

describe('JumpToLatest on a phone', () => {
  it('is a 44pt round button at the right with the count', () => {
    render(<JumpToLatest unseen={3} onJump={() => {}} />)
    const button = screen.getByRole('button', { name: 'Jump to latest, 3 new' })
    expect(button.className).toContain('size-11')
    expect(button.className).toContain('right-3')
    expect(button).toHaveTextContent('3')
  })
})
