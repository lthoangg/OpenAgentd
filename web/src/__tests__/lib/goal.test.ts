import { describe, it, expect } from 'bun:test'
import type { ContentBlock, SessionGoal } from '@/api/types'
import {
  formatGoalDuration,
  formatGoalTokens,
  goalNow,
  goalTabTitle,
  goalTurnInfo,
  goalTurnReason,
  parseGoalClaim,
  restoredPromptText,
} from '@/lib/goal'

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'g1',
    session_id: 's1',
    objective: 'web tests pass',
    status: 'active',
    pause_reason: null,
    detail: null,
    max_turns: 50,
    token_budget: null,
    turns_used: 6,
    tokens_used: 412_000,
    active_seconds: 750,
    rejected_claims: 0,
    created_at: '2026-10-24T00:00:00Z',
    updated_at: '2026-10-24T00:10:00Z',
    ended_at: null,
    ...overrides,
  }
}

const IDLE = { running: false, waitingForUser: false, planMode: false, queuedMessages: 0, subagentsRunning: 0 }

describe('goalTabTitle', () => {
  it('counts the running turn while the goal works', () => {
    expect(goalTabTitle(makeGoal(), true)).toBe('Goal 7/50')
    expect(goalTabTitle(makeGoal(), false)).toBe('Goal 6/50')
    expect(goalTabTitle(makeGoal({ turns_used: 0 }), false)).toBe('Goal 1/50')
  })

  it('names how a goal stopped, and stays plain without one', () => {
    expect(goalTabTitle(makeGoal({ status: 'paused', pause_reason: 'turn_limit' }), false)).toBe('Goal paused')
    expect(goalTabTitle(makeGoal({ status: 'paused', pause_reason: 'blocked' }), false)).toBe('Goal blocked')
    expect(goalTabTitle(makeGoal({ status: 'achieved' }), false)).toBe('Goal achieved')
    expect(goalTabTitle(makeGoal({ status: 'cleared' }), false)).toBe('Goal')
    expect(goalTabTitle(null, true)).toBe('Goal')
  })
})

describe('goalNow', () => {
  it('says which turn runs, and that queued messages go first', () => {
    expect(goalNow(makeGoal(), { ...IDLE, running: true })).toEqual({ tone: 'active', text: 'Working on turn 7 of 50', note: null })
    expect(goalNow(makeGoal(), { ...IDLE, running: true, queuedMessages: 2 })?.note).toBe("2 queued messages run before the goal's next turn.")
  })

  it('names what the goal waits for', () => {
    expect(goalNow(makeGoal(), { ...IDLE, running: true, waitingForUser: true })).toMatchObject({ tone: 'wait', text: 'Waiting for your answer' })
    expect(goalNow(makeGoal(), { ...IDLE, planMode: true })).toMatchObject({ tone: 'wait', text: 'Waiting for Code mode' })
    expect(goalNow(makeGoal(), { ...IDLE, subagentsRunning: 1 })).toMatchObject({ tone: 'active', text: 'Waiting for 1 subagent' })
    expect(goalNow(makeGoal(), IDLE)).toMatchObject({ tone: 'active', text: 'Starting the next turn' })
  })

  it('says how a goal stopped', () => {
    expect(goalNow(makeGoal({ status: 'paused', pause_reason: 'stopped' }), IDLE)).toMatchObject({ tone: 'paused', text: 'Paused: stopped' })
    expect(goalNow(makeGoal({ status: 'paused', pause_reason: 'blocked' }), IDLE)).toMatchObject({ tone: 'blocked', text: 'Blocked' })
    expect(goalNow(makeGoal({ status: 'achieved', turns_used: 3 }), IDLE)).toMatchObject({ tone: 'achieved', text: 'Achieved in 3 turns' })
    expect(goalNow(makeGoal({ status: 'cleared' }), IDLE)).toBeNull()
  })
})

describe('formatting', () => {
  it('shortens token counts and durations', () => {
    expect(formatGoalTokens(950)).toBe('950')
    expect(formatGoalTokens(412_300)).toBe('412k')
    expect(formatGoalTokens(999_600)).toBe('1M')
    expect(formatGoalTokens(1_200_000)).toBe('1.2M')
    expect(formatGoalTokens(2_000_000)).toBe('2M')
    expect(formatGoalDuration(45)).toBe('45s')
    expect(formatGoalDuration(600)).toBe('10m')
    expect(formatGoalDuration(3_900)).toBe('1h 5m')
  })
})

describe('transcript markers', () => {
  it('tells a goal continuation apart from a prompt', () => {
    const cont: ContentBlock = { id: 'u2', type: 'user', content: '<goal_reminder …>', extra: { goal_turn: { id: 'g1', turn: 3, max_turns: 50 } } }
    const prompt: ContentBlock = { id: 'u3', type: 'user', content: 'hello' }
    expect(goalTurnInfo(cont)).toEqual({ turn: 3, maxTurns: 50, why: null, check: null })
    expect(goalTurnInfo(prompt)).toBeNull()
  })

  it('reads why the goal went on, with the rejecting check in its own words', () => {
    const turn = (goal_turn: Record<string, unknown>): ContentBlock => ({ id: 'u2', type: 'user', content: '<goal_reminder …>', extra: { goal_turn } })
    const rejected = goalTurnInfo(turn({ id: 'g1', turn: 3, max_turns: 50, why: 'rejected', check: ' No `bun test` output. ', tokens_used: 412_000 }))!
    expect(rejected).toEqual({ turn: 3, maxTurns: 50, why: 'rejected', check: 'No `bun test` output.' })
    expect(goalTurnReason(rejected)).toEqual({ short: 'check said not yet', text: 'No `bun test` output.' })
    // A rejection whose words were not recorded still says what happened.
    expect(goalTurnReason(goalTurnInfo(turn({ turn: 3, why: 'rejected' }))!).text).toBe("The check did not accept the agent's claim that the goal was met.")

    const unclaimed = goalTurnInfo(turn({ turn: 2, max_turns: 50, why: 'unclaimed' }))!
    expect(goalTurnReason(unclaimed).short).toBe('not done yet')
    expect(goalTurnReason(goalTurnInfo(turn({ turn: 2, why: 'check_failed' }))!).short).toBe('check failed')
    expect(goalTurnReason(goalTurnInfo(turn({ turn: 2, why: 'resumed' }))!).short).toBe('resumed')
  })

  it('explains a turn from before the reason was recorded, without a label', () => {
    const old = goalTurnInfo({ id: 'u2', type: 'user', content: '…', extra: { goal_turn: { turn: 2, max_turns: 50, why: 'later', check: 'stale' } } })!
    expect(old).toMatchObject({ why: null, check: null })
    expect(goalTurnReason(old)).toEqual({ short: null, text: 'The last turn ended before the goal was met, so the goal went on.' })
  })

  it('gives a prompt back as written, and a goal turn as nothing', () => {
    expect(restoredPromptText('tests pass', { mentions: ['a.ts'] })).toBe('tests pass')
    expect(restoredPromptText('<goal_reminder …>', { goal_turn: { id: 'g1', turn: 2 } })).toBeNull()
    expect(restoredPromptText('hello', null)).toBe('hello')
  })
})

describe('parseGoalClaim', () => {
  const claim = JSON.stringify({ status: 'complete', evidence: '- `bun test` → 0 fail\n- `tsc -b` → exit 0' })

  it('reads an accepted claim with its evidence', () => {
    const result = 'The check confirmed the goal is met: Both commands pass.\nThe goal is achieved. Stop goal work and give the user a short summary.'
    expect(parseGoalClaim(claim, result, true)).toEqual({ kind: 'achieved', reason: 'Both commands pass.', evidence: ['`bun test` → 0 fail', '`tsc -b` → exit 0'] })
  })

  it('reads a rejected claim, and one that paused the goal', () => {
    const rejected = 'The check did not accept the claim: No test output is shown.\nThe goal stays active. Keep working on what the check names.'
    expect(parseGoalClaim(claim, rejected, true)).toMatchObject({ kind: 'rejected', reason: 'No test output is shown.', paused: false })
    const paused = 'The check did not accept the claim: Still no output.\nIt rejected 3 claims in a row, so the goal is paused until the user resumes it.'
    expect(parseGoalClaim(claim, paused, true)).toMatchObject({ kind: 'rejected', reason: 'Still no output.', paused: true })
  })

  it('reads a check that failed as neither accepted nor rejected', () => {
    const failed = 'The completion check failed: The check replied without a verdict.\nThe claim was neither accepted nor rejected, and the goal stays active.'
    expect(parseGoalClaim(claim, failed, true)).toMatchObject({ kind: 'unchecked', reason: 'The check replied without a verdict.', paused: false })
    const paused = 'The completion check failed: The check could not run: timed out.\nThe check failed 3 times in a row, so the goal is paused until the user resumes it.'
    expect(parseGoalClaim(claim, paused, true)).toMatchObject({ kind: 'unchecked', reason: 'The check could not run: timed out.', paused: true })
  })

  it('reads a blocker and a claim still being checked', () => {
    const blocked = JSON.stringify({ status: 'blocked', reason: 'The staging key is missing.' })
    expect(parseGoalClaim(blocked, 'The goal is paused as blocked until the user resumes it.', true)).toEqual({ kind: 'blocked', reason: 'The staging key is missing.' })
    expect(parseGoalClaim(claim, undefined, false)).toMatchObject({ kind: 'checking' })
    expect(parseGoalClaim(claim, 'There is no goal.', true)).toEqual({ kind: 'other', text: 'There is no goal.' })
  })

  it('carries the claimed evidence while the claim is checked, and after a rejection or a failed check', () => {
    const evidence = ['`bun test` → 0 fail', '`tsc -b` → exit 0']
    expect(parseGoalClaim(claim, undefined, false)).toEqual({ kind: 'checking', evidence })
    expect(parseGoalClaim(claim, 'The check did not accept the claim: No output.', true)).toEqual({ kind: 'rejected', reason: 'No output.', paused: false, evidence })
    expect(parseGoalClaim(claim, 'The completion check failed: timed out.', true)).toEqual({ kind: 'unchecked', reason: 'timed out.', paused: false, evidence })
    expect(parseGoalClaim('not json', undefined, false)).toEqual({ kind: 'checking', evidence: [] })
  })
})
