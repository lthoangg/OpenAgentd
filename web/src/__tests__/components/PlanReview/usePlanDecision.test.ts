/**
 * The words and limits of the plan decision, shared by the Plan tab and the
 * transcript card: whenever Keep going is on, Approve says so, with the turns.
 */
import { describe, expect, it } from 'bun:test'
import { approveLabel, MAX_GOAL_TURNS, turnsError } from '@/components/PlanReview/usePlanDecision'

describe('approveLabel', () => {
  it('is a bare "Approve" only while no goal would start', () => {
    expect(approveLabel(false, '50')).toBe('Approve')
    expect(approveLabel(false, 'nonsense')).toBe('Approve')
  })

  it('names the goal and its real turn count while Keep going is on', () => {
    expect(approveLabel(true, '10')).toBe('Approve and keep going (10 turns)')
    expect(approveLabel(true, '1')).toBe('Approve and keep going (1 turn)')
    expect(approveLabel(true, String(MAX_GOAL_TURNS))).toBe(`Approve and keep going (${MAX_GOAL_TURNS} turns)`)
  })

  it('drops the count rather than print a wrong one when the turns are not a valid number', () => {
    for (const text of ['', '0', '-3', '2.5', 'abc', String(MAX_GOAL_TURNS + 1)]) {
      expect(approveLabel(true, text)).toBe('Approve and keep going')
    }
  })
})

describe('turnsError', () => {
  it('accepts a whole number from 1 to the cap', () => {
    expect(turnsError('1')).toBeNull()
    expect(turnsError('50')).toBeNull()
    expect(turnsError(String(MAX_GOAL_TURNS))).toBeNull()
  })

  it('says what is allowed otherwise', () => {
    expect(turnsError('0')).toBe(`Turns: a whole number from 1 to ${MAX_GOAL_TURNS}`)
    expect(turnsError('1.5')).toBe(`Turns: a whole number from 1 to ${MAX_GOAL_TURNS}`)
    expect(turnsError(String(MAX_GOAL_TURNS + 1))).not.toBeNull()
  })
})
