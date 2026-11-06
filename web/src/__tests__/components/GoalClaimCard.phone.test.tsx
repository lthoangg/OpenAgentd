/**
 * On a phone the goal check folds into one 44pt row, "Goal · achieved";
 * a tap opens the evidence as 44pt rows (mockups J4 4.2, J6).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

import { GoalClaimCard } from '@/components/GoalClaimCard'

afterEach(cleanup)

const CLAIM = JSON.stringify({ status: 'complete', evidence: '- `bun test` → 1,842 pass\n- tsc clean' })
const ACHIEVED = 'The check confirmed the goal is met: The run shows 0 failures.\nThe goal is achieved. Stop goal work and give the user a short summary.'

describe('GoalClaimCard on a phone', () => {
  it('is one row that opens the evidence as 44pt rows', () => {
    render(<GoalClaimCard args={CLAIM} result={ACHIEVED} done />)
    const toggle = screen.getByRole('button', { name: /Goal/ })
    expect(toggle.className).toContain('min-h-11')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const list = document.querySelector('[data-evidence-list="phone"]')!
    const rows = Array.from(list.querySelectorAll('li'))
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row.className).toContain('min-h-11')
  })
})
