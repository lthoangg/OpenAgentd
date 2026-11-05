/**
 * TranscriptDivider — the one divider of the transcript, shared by the goal,
 * restart and compaction markers: a hairline, a centred label, a hairline;
 * collapsible (a toggle with a chevron) only when it has a body.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TranscriptDivider } from '@/components/AgentView/TranscriptDivider'
import { RestartDivider } from '@/components/AgentView/RestartDivider'
import { GoalTurnDivider } from '@/components/AgentView/GoalTurnDivider'
import { CompactionDivider } from '@/components/CompactionDivider'

afterEach(cleanup)

const hairlines = (root: Element) => Array.from(root.querySelectorAll('span[aria-hidden="true"].h-px'))

describe('TranscriptDivider', () => {
  it('is a hairline, a plain centred label and a hairline, with no toggle', () => {
    const { container } = render(<TranscriptDivider label="Server restarted" />)

    expect(hairlines(container)).toHaveLength(2)
    expect(screen.getByText('Server restarted').className).toContain('text-xs')
    expect(screen.getByText('Server restarted').className).toContain('text-(--color-text-muted)')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('marks a plain label as a live status when asked', () => {
    render(<TranscriptDivider label="Summarizing…" labelRole="status" />)

    expect(screen.getByRole('status').textContent).toBe('Summarizing…')
  })

  it('turns the label into a toggle with a chevron that turns when open', () => {
    const onToggle = mock((..._args: unknown[]) => {})
    const { rerender } = render(<TranscriptDivider label="Details" onToggle={onToggle} controls="body-1" open={false} />)

    const toggle = screen.getByRole('button', { name: 'Details' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('body-1')
    expect(toggle.querySelector('svg')?.getAttribute('class')).not.toContain('rotate-90')
    // Touch keeps a 36px target.
    expect(toggle.className).toContain('pointer-coarse:min-h-9')

    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle.mock.calls[0][0]).toBe(toggle)

    rerender(<TranscriptDivider label="Details" onToggle={onToggle} controls="body-1" open />)
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Details' }).querySelector('svg')?.getAttribute('class')).toContain('rotate-90')
  })

  it('tints only the words it is told to', () => {
    render(<TranscriptDivider label="Couldn't summarize" tone="text-(--color-error)" />)

    expect(screen.getByText("Couldn't summarize").className).toContain('text-(--color-error)')
  })
})

describe('the three transcript dividers share it', () => {
  const goal = { turn: 2, maxTurns: 50, why: 'unclaimed' as const, check: null }

  it('draw the same hairlines and the same muted 12px words', () => {
    const restart = render(<RestartDivider info={{ continued: true }} />)
    const restartRow = screen.getByRole('note')
    expect(hairlines(restartRow)).toHaveLength(2)
    const restartLabel = screen.getByText('Server restarted · turn continued')
    expect(restartLabel.className).toContain('text-xs')
    expect(restartLabel.className).toContain('text-(--color-text-muted)')
    const rule = hairlines(restartRow)[0].className
    restart.unmount()

    const goalView = render(<GoalTurnDivider info={goal} />)
    const goalToggle = screen.getByRole('button', { name: /Goal · turn 2\/50/ })
    expect(hairlines(goalView.container)).toHaveLength(2)
    expect(hairlines(goalView.container)[0].className).toBe(rule)
    expect(goalToggle.className).toContain('text-xs')
    expect(goalToggle.className).toContain('text-(--color-text-muted)')
    goalView.unmount()

    const compaction = render(<CompactionDivider state="compacted" summary="A summary." />)
    const compactionToggle = screen.getByRole('button', { name: /Earlier messages summarized/ })
    expect(hairlines(compaction.container)).toHaveLength(2)
    expect(hairlines(compaction.container)[0].className).toBe(rule)
    expect(compactionToggle.className).toContain('text-xs')
    // A finished compaction reads in the same muted words as the others.
    expect(compactionToggle.className).toContain('text-(--color-text-muted)')
  })

  it('open and close the same way: aria-expanded, a chevron, a body they control', () => {
    render(<GoalTurnDivider info={{ ...goal, why: 'rejected', check: 'No test run.' }} />)
    const toggle = screen.getByRole('button', { name: /Goal · turn 2\/50/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.querySelector('svg')).not.toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull()
  })

  it('keeps a failed compaction red and gives it no toggle', () => {
    render(<CompactionDivider state="compacted" error summary="x" />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText("Couldn't summarize earlier messages").className).toContain('text-(--color-error)')
  })
})
