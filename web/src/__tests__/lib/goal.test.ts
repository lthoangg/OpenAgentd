import { describe, it, expect } from 'bun:test'
import type { ContentBlock, SessionGoal } from '@/api/types'
import {
  formatGoalDuration,
  formatGoalTokens,
  goalChipState,
  goalSubmit,
  goalTurnInfo,
  isGoalObjectiveBlock,
  parseGoalClaim,
  parseGoalCommand,
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

const IDLE = { running: false, waitingForUser: false, planMode: false }

describe('parseGoalCommand', () => {
  it('reads the status, the three actions, and an objective', () => {
    expect(parseGoalCommand('/goal')).toEqual({ kind: 'status' })
    expect(parseGoalCommand('  /goal status ')).toEqual({ kind: 'status' })
    expect(parseGoalCommand('/goal Pause')).toEqual({ kind: 'action', action: 'pause' })
    expect(parseGoalCommand('/goal resume')).toEqual({ kind: 'action', action: 'resume' })
    expect(parseGoalCommand('/goal clear')).toEqual({ kind: 'action', action: 'clear' })
    expect(parseGoalCommand('/goal web tests pass\nand tsc is clean')).toEqual({ kind: 'set', objective: 'web tests pass\nand tsc is clean' })
  })

  it('treats a sentence that starts with an action word as an objective', () => {
    expect(parseGoalCommand('/goal clear the lint warnings')).toEqual({ kind: 'set', objective: 'clear the lint warnings' })
  })

  it('ignores other text and other commands', () => {
    expect(parseGoalCommand('set a goal')).toBeNull()
    expect(parseGoalCommand('/goals')).toBeNull()
    expect(parseGoalCommand('/btw goal?')).toBeNull()
  })
})

describe('goalSubmit', () => {
  it('asks before replacing a live goal, and starts a new one otherwise', () => {
    const live = makeGoal()
    expect(goalSubmit('/goal ship it', 's1', live)).toEqual({ kind: 'set', objective: 'ship it', replaces: live })
    expect(goalSubmit('/goal ship it', 's1', makeGoal({ status: 'achieved' }))).toEqual({ kind: 'set', objective: 'ship it', replaces: null })
    expect(goalSubmit('/goal ship it', null, undefined)).toEqual({ kind: 'set', objective: 'ship it', replaces: null })
  })

  it('acts on a live goal only', () => {
    expect(goalSubmit('/goal pause', 's1', makeGoal())).toEqual({ kind: 'action', action: 'pause' })
    expect(goalSubmit('/goal pause', 's1', makeGoal({ status: 'cleared' }))).toEqual({ kind: 'no-goal' })
    expect(goalSubmit('/goal resume', null, null)).toEqual({ kind: 'no-session' })
    expect(goalSubmit('/goal', 's1', makeGoal({ status: 'achieved' }))).toEqual({ kind: 'show' })
    expect(goalSubmit('/goal', 's1', null)).toEqual({ kind: 'no-goal' })
  })

  it('refuses an objective over the length limit', () => {
    expect(goalSubmit(`/goal ${'x'.repeat(4001)}`, 's1', null)).toEqual({ kind: 'too-long' })
    expect(goalSubmit('hello', 's1', null)).toEqual({ kind: 'not-goal' })
  })
})

describe('goalChipState', () => {
  it('counts the running turn and the time while the goal works', () => {
    expect(goalChipState(makeGoal(), { ...IDLE, running: true })).toEqual({ tone: 'active', label: 'Goal · 7/50 · 12m 30s', short: '7/50' })
    expect(goalChipState(makeGoal({ active_seconds: 20 }), IDLE)).toEqual({ tone: 'active', label: 'Goal · 6/50', short: '6/50' })
  })

  it('names why a goal waits or stopped', () => {
    expect(goalChipState(makeGoal(), { ...IDLE, waitingForUser: true })?.label).toBe('Goal · waiting for you')
    expect(goalChipState(makeGoal(), { ...IDLE, planMode: true })?.label).toBe('Goal · waiting for Code mode')
    expect(goalChipState(makeGoal({ status: 'paused', pause_reason: 'turn_limit' }), IDLE)).toEqual({ tone: 'paused', label: 'Goal paused · turn limit', short: 'Paused' })
    expect(goalChipState(makeGoal({ status: 'paused', pause_reason: 'blocked' }), IDLE)?.tone).toBe('blocked')
    expect(goalChipState(makeGoal({ status: 'achieved' }), IDLE)?.label).toBe('Goal achieved')
  })

  it('shows nothing without a goal or for a cleared one', () => {
    expect(goalChipState(null, IDLE)).toBeNull()
    expect(goalChipState(makeGoal({ status: 'cleared' }), IDLE)).toBeNull()
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
  it('tells a goal continuation and an objective apart from a prompt', () => {
    const cont: ContentBlock = { id: 'u2', type: 'user', content: '<goal_reminder …>', extra: { goal_turn: { id: 'g1', turn: 3, max_turns: 50 } } }
    const objective: ContentBlock = { id: 'u1', type: 'user', content: 'ship it', extra: { goal: { id: 'g1' } } }
    const prompt: ContentBlock = { id: 'u3', type: 'user', content: 'hello' }
    expect(goalTurnInfo(cont)).toEqual({ turn: 3, maxTurns: 50 })
    expect(goalTurnInfo(prompt)).toBeNull()
    expect(isGoalObjectiveBlock(objective)).toBe(true)
    expect(isGoalObjectiveBlock(prompt)).toBe(false)
  })

  it('gives back a goal objective as its /goal command, and a goal turn as nothing', () => {
    expect(restoredPromptText('tests pass', { goal: { id: 'g1' } })).toBe('/goal tests pass')
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
