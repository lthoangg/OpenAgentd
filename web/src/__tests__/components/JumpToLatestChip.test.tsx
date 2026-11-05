import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useFakeTimers } from '../fake-timers'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { JumpToLatest, JumpToLatestChip } from '@/components/JumpToLatestChip'
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

  it('says "Jump to latest" when nothing new arrived', () => {
    useTranscriptFollowStore.setState({ unseen: 0, jumpToLatest: () => {} })
    render(<JumpToLatestChip />)

    expect(screen.getByRole('button', { name: 'Jump to latest' }).textContent).toBe('Jump to latest')
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

  it('has no border: the chip floats on its own surface and shadow', () => {
    useTranscriptFollowStore.setState({ unseen: 2, jumpToLatest: () => {} })
    render(<JumpToLatestChip />)

    expect(screen.getByRole('button', { name: /jump to latest/i }).className).not.toMatch(/(?<![\w-])border(?![\w-])/)
  })

  it('is sized like the run deck on touch screens: 13px words on a phone, 36px tall', () => {
    useTranscriptFollowStore.setState({ unseen: 2, jumpToLatest: () => {} })
    render(<JumpToLatestChip />)

    const classes = screen.getByRole('button', { name: /jump to latest/i }).className.split(/\s+/)
    // ``text-xs`` is 17px on a phone (iOS sizes); the deck's labels are 13px.
    expect(classes).toContain('phone:text-meta')
    expect(classes).toContain('pointer-coarse:h-9')
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

describe('JumpToLatest, in the transcript itself', () => {
  it('is the same chip, with the count, and jumps through the handler it is given', () => {
    const onJump = mock(() => {})
    render(<JumpToLatest unseen={5} side="inside" onJump={onJump} />)

    const chip = screen.getByRole('button', { name: 'Jump to latest, 5 new' })
    expect(chip.dataset.side).toBe('inside')
    expect(chip.textContent).toBe('5 new')
    fireEvent.click(chip)
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('leaves at once, with no fade, when asked not to fade out', () => {
    const { rerender, container } = render(<JumpToLatest unseen={0} side="inside" fadeOut={false} onJump={() => {}} />)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()

    rerender(<JumpToLatest unseen={null} side="inside" fadeOut={false} onJump={() => {}} />)
    expect(container.querySelector('button')).toBeNull()
  })
})
