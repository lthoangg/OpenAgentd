import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useFakeTimers } from '../fake-timers'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { JumpToLatestChip } from '@/components/JumpToLatestChip'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'

beforeEach(() => useTranscriptFollowStore.setState({ unseen: null, jumpToLatest: null }))
afterEach(cleanup)

describe('JumpToLatestChip', () => {
  it('stays hidden while the transcript follows the live end', () => {
    render(<JumpToLatestChip />)
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
  })

  it('shows how much arrived since the reader scrolled away', () => {
    useTranscriptFollowStore.setState({ unseen: 3, jumpToLatest: () => {} })
    render(<JumpToLatestChip />)

    const chip = screen.getByRole('button', { name: 'Jump to latest, 3 new' })
    expect(chip.textContent).toBe('3 new')
  })

  it('is a bare arrow when nothing new arrived', () => {
    useTranscriptFollowStore.setState({ unseen: 0, jumpToLatest: () => {} })
    render(<JumpToLatestChip />)

    expect(screen.getByRole('button', { name: 'Jump to latest' }).textContent).toBe('')
  })

  it('jumps to the latest', () => {
    const jumpToLatest = mock(() => {})
    useTranscriptFollowStore.setState({ unseen: 1, jumpToLatest })
    render(<JumpToLatestChip />)

    fireEvent.click(screen.getByRole('button', { name: /jump to latest/i }))
    expect(jumpToLatest).toHaveBeenCalledTimes(1)
  })

  it('sits below the composer when the composer is near the top', () => {
    useTranscriptFollowStore.setState({ unseen: 1, jumpToLatest: () => {} })
    render(<JumpToLatestChip below />)

    expect(screen.getByRole('button', { name: /jump to latest/i }).dataset.side).toBe('below')
  })

  it('fades out of reach, keeping its count, when the reader is back at the live end', () => {
    useTranscriptFollowStore.setState({ unseen: 4, jumpToLatest: () => {} })
    const { container } = render(<JumpToLatestChip />)
    const chip = screen.getByRole('button', { name: 'Jump to latest, 4 new' })
    expect(chip.className).toContain('animate-in')

    const timers = useFakeTimers()
    try {
      act(() => useTranscriptFollowStore.setState({ unseen: null }))
      expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
      expect(chip.textContent).toBe('4 new')
      expect(chip.className).toContain('animate-out')
      act(() => timers.tick(200))
      expect(container.querySelector('button')).toBeNull()
    } finally {
      timers.restore()
    }
  })
})
