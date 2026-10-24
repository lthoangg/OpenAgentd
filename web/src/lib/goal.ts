/**
 * `/goal` helpers: the command parser, the chip's state, the transcript's
 * goal markers, and the `update_goal` card's outcome. Pure, so the rules
 * stay testable without rendering.
 */
import type { ContentBlock, GoalPauseReason, SessionGoal } from '@/api/types'

/** Matches ``appv3_agent::tools::goal::UPDATE_GOAL_TOOL``. */
export const UPDATE_GOAL_TOOL = 'update_goal'
/** Matches ``appv3_agent::goal::MAX_OBJECTIVE_CHARS``. */
export const MAX_GOAL_OBJECTIVE_CHARS = 4000

export function isSessionGoal(value: unknown): value is SessionGoal {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string'
    && typeof v.objective === 'string'
    && typeof v.status === 'string'
    && typeof v.turns_used === 'number'
    && typeof v.max_turns === 'number'
}

/** Active or paused: the goal still runs, or can be resumed. */
export function isLiveGoal(goal: SessionGoal | null | undefined): goal is SessionGoal {
  return goal?.status === 'active' || goal?.status === 'paused'
}

// ── /goal command ─────────────────────────────────────────────────────────────

export type GoalAction = 'pause' | 'resume' | 'clear'

export type GoalCommand =
  | { kind: 'status' }
  | { kind: 'action'; action: GoalAction }
  | { kind: 'set'; objective: string }

/** ``/goal``, ``/goal status|pause|resume|clear``, or ``/goal <objective>``; ``null`` for anything else. */
export function parseGoalCommand(content: string): GoalCommand | null {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?$/i.exec(content)
  if (!match) return null
  const rest = (match[1] ?? '').trim()
  const word = rest.toLowerCase()
  if (!rest || word === 'status') return { kind: 'status' }
  if (word === 'pause' || word === 'resume' || word === 'clear') return { kind: 'action', action: word }
  return { kind: 'set', objective: rest }
}

export type GoalSubmit =
  | { kind: 'not-goal' }
  /** Status or an action in a draft that has no session yet. */
  | { kind: 'no-session' }
  /** Status or an action with no live goal to act on. */
  | { kind: 'no-goal' }
  | { kind: 'show' }
  | { kind: 'action'; action: GoalAction }
  | { kind: 'too-long' }
  /** ``replaces`` is the live goal the new one would clear (confirm first). */
  | { kind: 'set'; objective: string; replaces: SessionGoal | null }

/** What submitting ``content`` from the composer means for ``/goal``. */
export function goalSubmit(content: string, sessionId: string | null, goal: SessionGoal | null | undefined): GoalSubmit {
  const command = parseGoalCommand(content)
  if (!command) return { kind: 'not-goal' }
  if (command.kind === 'set') {
    if (command.objective.length > MAX_GOAL_OBJECTIVE_CHARS) return { kind: 'too-long' }
    return { kind: 'set', objective: command.objective, replaces: sessionId && isLiveGoal(goal) ? goal : null }
  }
  if (!sessionId) return { kind: 'no-session' }
  const achieved = goal?.status === 'achieved'
  if (!isLiveGoal(goal)) return command.kind === 'status' && achieved ? { kind: 'show' } : { kind: 'no-goal' }
  return command.kind === 'status' ? { kind: 'show' } : { kind: 'action', action: command.action }
}

// ── chip ──────────────────────────────────────────────────────────────────────

export type GoalTone = 'active' | 'wait' | 'paused' | 'blocked' | 'achieved'

export interface GoalChipState {
  tone: GoalTone
  /** Full label (desktop). */
  label: string
  /** Collapsed label (phones). */
  short: string
}

const PAUSE_LABELS: Record<GoalPauseReason, string> = {
  stopped: 'stopped',
  user: 'paused by you',
  blocked: 'blocked',
  turn_limit: 'turn limit',
  token_limit: 'token budget',
  no_progress: 'no progress',
  unverified: 'check rejected',
  check_failed: 'check failed',
  error: 'turn failed',
  restart: 'app restarted',
}

export function pauseReasonLabel(reason: GoalPauseReason | null): string {
  return reason ? PAUSE_LABELS[reason] ?? reason : 'paused'
}

/** One sentence on why the goal is paused, for the popover. */
export function pauseReasonText(goal: SessionGoal): string {
  switch (goal.pause_reason) {
    case 'stopped': return 'You pressed Stop.'
    case 'user': return 'You paused it.'
    case 'blocked': return 'The agent reported a blocker it cannot get past alone.'
    case 'turn_limit': return `It used all ${goal.max_turns} turns. Resume grants another batch.`
    case 'token_limit': return 'It reached its token budget. Resume grants another budget.'
    case 'no_progress': return 'Two turns in a row made no tool calls.'
    case 'unverified': return 'The check rejected three completion claims in a row.'
    case 'check_failed': return 'The completion check failed three times in a row, without accepting or rejecting a claim.'
    case 'error': return 'A turn failed.'
    case 'restart': return 'The app restarted while it was running.'
    default: return 'It is paused.'
  }
}

/** The turn a goal is on: the running one while a turn runs, else the last finished. */
export function goalTurnNumber(goal: SessionGoal, running: boolean): number {
  return goal.status === 'active' && running ? Math.min(goal.turns_used + 1, goal.max_turns) : goal.turns_used
}

/** The chip for ``goal``; ``null`` when there is nothing to show (no goal, or a cleared one). */
export function goalChipState(
  goal: SessionGoal | null | undefined,
  ctx: { running: boolean; waitingForUser: boolean; planMode: boolean },
): GoalChipState | null {
  if (!goal || goal.status === 'cleared') return null
  if (goal.status === 'achieved') return { tone: 'achieved', label: 'Goal achieved', short: 'Done' }
  const turns = `${goalTurnNumber(goal, ctx.running)}/${goal.max_turns}`
  if (goal.status === 'paused') {
    if (goal.pause_reason === 'blocked') return { tone: 'blocked', label: 'Goal blocked', short: 'Blocked' }
    return { tone: 'paused', label: `Goal paused · ${pauseReasonLabel(goal.pause_reason)}`, short: 'Paused' }
  }
  if (ctx.waitingForUser) return { tone: 'wait', label: 'Goal · waiting for you', short: turns }
  if (ctx.planMode) return { tone: 'paused', label: 'Goal · waiting for Code mode', short: 'Plan' }
  const time = goal.active_seconds >= 60 ? ` · ${formatGoalDuration(goal.active_seconds)}` : ''
  return { tone: 'active', label: `Goal · ${turns}${time}`, short: turns }
}

export function formatGoalTokens(n: number): string {
  // From 999,500 up the rounded thousands would read "1000k".
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(n >= 9_950_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function formatGoalDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

// ── transcript ────────────────────────────────────────────────────────────────

/** A turn the goal started on its own (``extra.goal_turn``): shown as a divider, not a bubble. */
export function goalTurnInfo(block: ContentBlock): { turn: number; maxTurns: number } | null {
  if (block.type !== 'user') return null
  const info = block.extra?.goal_turn as { turn?: unknown; max_turns?: unknown } | undefined
  if (!info || typeof info !== 'object' || typeof info.turn !== 'number') return null
  return { turn: info.turn, maxTurns: typeof info.max_turns === 'number' ? info.max_turns : info.turn }
}

export function isGoalTurnBlock(block: ContentBlock): boolean {
  return goalTurnInfo(block) !== null
}

/** The message that set a goal (``extra.goal``). */
export function isGoalObjectiveBlock(block: ContentBlock): boolean {
  return block.type === 'user' && Boolean(block.extra?.goal) && typeof block.extra?.goal === 'object'
}

/**
 * The composer text that gives a taken-back prompt back to the user (undo,
 * edit, a failed retry): a goal's objective as its ``/goal`` command, so
 * sending it sets the goal again, and ``null`` for a goal's own turn, which
 * is a hidden reminder the user never wrote.
 */
export function restoredPromptText(content: string, extra: Record<string, unknown> | null | undefined): string | null {
  if (extra?.goal_turn) return null
  if (extra?.goal && typeof extra.goal === 'object') return `/goal ${content}`
  return content
}

// ── update_goal card ──────────────────────────────────────────────────────────

export type GoalClaim =
  | { kind: 'checking'; evidence: string[] }
  | { kind: 'achieved'; reason: string; evidence: string[] }
  | { kind: 'rejected'; reason: string; paused: boolean; evidence: string[] }
  /** The check gave no verdict or could not run: neither accepted nor rejected. */
  | { kind: 'unchecked'; reason: string; paused: boolean; evidence: string[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'other'; text: string }

function parseArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** The claimed evidence as list items: one per line, list markers dropped. */
export function evidenceItems(evidence: unknown): string[] {
  if (typeof evidence !== 'string') return []
  return evidence
    .split('\n')
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''))
    .filter(Boolean)
}

/** Text between ``prefix`` and the first of ``ends`` (both of the backend's tool results). */
function between(text: string, prefix: string, ends: string[]): string {
  let rest = text.slice(prefix.length)
  for (const end of ends) {
    const at = rest.indexOf(end)
    if (at >= 0) rest = rest.slice(0, at)
  }
  return rest.trim()
}

const MET = 'The check confirmed the goal is met:'
const NOT_MET = 'The check did not accept the claim:'
const CHECK_FAILED = 'The completion check failed:'
const BLOCKED = 'The goal is paused as blocked'

/** What an ``update_goal`` call came to, from its args and the tool result, with the evidence it claimed. */
export function parseGoalClaim(args: string | undefined, result: string | undefined, done: boolean): GoalClaim {
  const parsed = parseArgs(args)
  const evidence = evidenceItems(parsed.evidence)
  if (!done || result === undefined) return parsed.status === 'blocked' ? { kind: 'blocked', reason: String(parsed.reason ?? '') } : { kind: 'checking', evidence }
  const text = result.trim()
  if (text.startsWith(MET)) {
    return { kind: 'achieved', reason: between(text, MET, ['\nThe goal is achieved.']), evidence }
  }
  if (text.startsWith(NOT_MET)) {
    return { kind: 'rejected', reason: between(text, NOT_MET, ['\nThe goal stays active.', '\nIt rejected ']), paused: text.includes('\nIt rejected '), evidence }
  }
  if (text.startsWith(CHECK_FAILED)) {
    return { kind: 'unchecked', reason: between(text, CHECK_FAILED, ['\nThe claim was neither', '\nThe check failed ']), paused: text.includes('\nThe check failed '), evidence }
  }
  if (text.startsWith(BLOCKED)) return { kind: 'blocked', reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '' }
  return { kind: 'other', text }
}

/**
 * An ``update_goal`` call the user must see even in reader mode: a claim
 * being checked, the goal achieved, a blocker, or rejections or failed checks
 * that paused the goal. A claim the agent works on past is one more step of
 * the work.
 */
export function isGoalOutcome(block: ContentBlock): boolean {
  if (block.type !== 'tool' || block.toolName !== UPDATE_GOAL_TOOL) return false
  const claim = parseGoalClaim(block.toolArgs, block.toolResult, Boolean(block.toolDone))
  if (claim.kind === 'rejected' || claim.kind === 'unchecked') return claim.paused
  return claim.kind === 'checking' || claim.kind === 'achieved' || claim.kind === 'blocked'
}
