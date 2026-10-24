/**
 * The ``update_goal`` call reads as a goal-check card, in the same card
 * family as plan reviews and questions: what the agent claimed, and what the
 * check made of it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ToolCall } from '@/components/ToolCall'

afterEach(cleanup)

const CLAIM = JSON.stringify({ status: 'complete', evidence: '- `bun test` → 1,842 pass, 0 fail\n- `tsc -b` → exit 0' })
const REJECTED = 'The check did not accept the claim: No test output is shown.\nThe goal stays active. Keep working on what the check names, show the evidence, then claim completion again.'

describe('update_goal card', () => {
  it('says the claim is being checked, with its evidence one click away', () => {
    render(<ToolCall name="update_goal" args={CLAIM} done={false} />)

    const card = screen.getByRole('region', { name: 'Goal check' })
    expect(within(card).getByRole('status').textContent).toContain('Checking the claim')
    const evidence = within(card).getByRole('button', { name: /Claimed evidence · 2/ })
    expect(evidence.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(evidence)
    expect(evidence.getAttribute('aria-expanded')).toBe('true')
    expect(card.querySelectorAll('li')).toHaveLength(2)
  })

  it('shows an accepted claim as achieved, with the check and the evidence open', () => {
    const result = 'The check confirmed the goal is met: Both commands pass.\nThe goal is achieved. Stop goal work and give the user a short summary.'
    render(<ToolCall name="update_goal" args={CLAIM} result={result} done />)

    const card = screen.getByRole('region', { name: 'Goal achieved' })
    expect(card.dataset.goalClaim).toBe('achieved')
    expect(card.textContent).toContain('Both commands pass.')
    expect(card.textContent).not.toContain('Stop goal work')
    expect(within(card).getByRole('button', { name: /Evidence · 2/ }).getAttribute('aria-expanded')).toBe('true')
    expect(card.querySelectorAll('li')).toHaveLength(2)
    expect(card.querySelector('code')?.textContent).toBe('bun test')
  })

  it('shows a rejected claim with the check reason, and says the goal goes on', () => {
    render(<ToolCall name="update_goal" args={CLAIM} result={REJECTED} done />)

    const card = screen.getByRole('region', { name: 'Goal check' })
    expect(card.dataset.goalClaim).toBe('rejected')
    expect(card.textContent).toContain('Not yet')
    expect(card.textContent).toContain('No test output is shown.')
    expect(card.textContent).not.toContain('Keep working on what')
    expect(within(card).getByRole('button', { name: /Claimed evidence · 2/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the evidence when a live claim is accepted', () => {
    const result = 'The check confirmed the goal is met: Both commands pass.\nThe goal is achieved. Stop goal work and give the user a short summary.'
    const { rerender } = render(<ToolCall name="update_goal" args={CLAIM} done={false} />)
    rerender(<ToolCall name="update_goal" args={CLAIM} result={result} done />)

    const card = screen.getByRole('region', { name: 'Goal achieved' })
    expect(within(card).getByRole('button', { name: /Evidence · 2/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the evidence the way the user left it once they toggle it', () => {
    const { rerender } = render(<ToolCall name="update_goal" args={CLAIM} done={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Claimed evidence · 2/ }))
    rerender(<ToolCall name="update_goal" args={CLAIM} result={REJECTED} done />)

    expect(screen.getByRole('button', { name: /Claimed evidence · 2/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('says when rejected claims paused the goal', () => {
    const result = 'The check did not accept the claim: tsc still fails.\nIt rejected 3 claims in a row, so the goal is paused until the user resumes it.'
    render(<ToolCall name="update_goal" args={CLAIM} result={result} done />)

    const card = screen.getByRole('region', { name: 'Goal check' })
    expect(card.textContent).toContain('Not met · goal paused until you resume it')
    expect(card.textContent).toContain('tsc still fails.')
  })

  it('says a failed check neither accepted nor rejected the claim', () => {
    const result = 'The completion check failed: The check replied without a verdict.\nThe claim was neither accepted nor rejected, and the goal stays active.'
    render(<ToolCall name="update_goal" args={CLAIM} result={result} done />)

    const card = screen.getByRole('region', { name: 'Goal check' })
    expect(card.dataset.goalClaim).toBe('unchecked')
    expect(card.textContent).toContain('Check failed · the agent can claim again')
    expect(card.textContent).toContain('The check replied without a verdict.')
    expect(card.textContent).not.toContain('Not yet')
  })

  it('shows a blocker and that the goal waits for the user', () => {
    const args = JSON.stringify({ status: 'blocked', reason: 'The staging key is missing.' })
    render(<ToolCall name="update_goal" args={args} result="The goal is paused as blocked until the user resumes it." done />)

    const card = screen.getByRole('region', { name: 'Goal blocked' })
    expect(card.dataset.goalClaim).toBe('blocked')
    expect(card.textContent).toContain('The staging key is missing.')
    expect(card.textContent).toContain('Paused until you resume it')
    expect(within(card).queryByRole('button')).toBeNull()
  })
})
