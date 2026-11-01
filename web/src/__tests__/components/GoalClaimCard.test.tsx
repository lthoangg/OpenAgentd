/**
 * GoalClaimCard — the ``update_goal`` call as a card in the transcript's card
 * family: one thin frame with nothing bordered inside, and what the check says
 * and the reasons read at 12px (meta size is for the chip and the toggle).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { GoalClaimCard } from '@/components/GoalClaimCard'

afterEach(cleanup)

const BORDER = /(?<![\w-:])border(?:-[btlrxy])?(?![\w-])/

const CLAIM = JSON.stringify({ status: 'complete', evidence: '- `bun test` → 1,842 pass, 0 fail' })
const ACHIEVED = 'The check confirmed the goal is met: The run shows 0 failures.\nThe goal is achieved. Stop goal work and give the user a short summary.'
const REJECTED = 'The check did not accept the claim: No test output is shown.\nThe goal stays active. Keep working on what the check names, show the evidence, then claim completion again.'

describe('GoalClaimCard', () => {
  it('draws one thin frame and nothing bordered inside it', () => {
    render(<GoalClaimCard args={CLAIM} result={ACHIEVED} done />)

    const card = screen.getByRole('region', { name: /Goal check/ })
    expect(card.className).toContain('border-(--color-border-subtle)')
    // Inline code in the evidence is rendered content (InlineCodeText), not card chrome.
    const inside = Array.from(card.querySelectorAll('*')).filter((el) => el.tagName !== 'CODE' && BORDER.test(el.getAttribute('class') ?? ''))
    expect(inside.map((el) => el.tagName)).toEqual([])
  })

  it('reads the reason at 12px', () => {
    render(<GoalClaimCard args={CLAIM} result={ACHIEVED} done />)

    const reason = screen.getByText('The run shows 0 failures.').closest('p') as HTMLElement
    expect(reason.className).toContain('text-xs')
    expect(reason.className).not.toContain('text-meta')
  })

  it('reads what the check made of the claim at 12px, not as meta', () => {
    const { unmount } = render(<GoalClaimCard args={CLAIM} done={false} />)
    const checking = screen.getByText('A separate check is reviewing the claim.')
    expect(checking.className).toContain('text-xs')
    expect(checking.className).not.toContain('text-meta')
    unmount()

    render(<GoalClaimCard args={CLAIM} result={REJECTED} done />)
    const rejected = screen.getByText('The agent keeps working.')
    expect(rejected.className).toContain('text-xs')
    expect(rejected.className).not.toContain('text-meta')
  })
})
