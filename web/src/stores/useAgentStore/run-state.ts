/**
 * The session's run as this client knows it (``web/src/AGENTS.md`` → State
 * machines), and the one place each agent's status is written.
 *
 * ``sessionRun`` answers "is a turn live here?": an agent is working, the
 * lead waits on the user's answer, or this client just started or resumed a
 * turn (a send, a compact, an answer) and no agent has said so yet. Every
 * "working" flag the UI reads (Stop, Undo, the dots, the composer) is
 * ``isRunLive`` over it. ``rowMarked`` remembers that the sidebar row was
 * already told the session runs: every member of a team reports ``working``,
 * and one patch per turn is enough.
 *
 * Each agent's own status (``AgentStream.status``) mirrors the backend's
 * member state (``appv3/crates/agent/data/session_states.json``); the server
 * owns that machine, so any status may follow any other. It is written only
 * through ``setAgentStatus`` here, beside the run it feeds.
 */
import { defineMachine } from '@/lib/machine'
import type { AgentStore, AgentStream, SessionStatus } from './types'

export type SessionRun =
  | { kind: 'idle' }
  | { kind: 'running'; rowMarked: boolean }

export type RunEvent =
  /** This client started or resumed a turn: a send, a compact, an answer, an injected message. */
  | { type: 'start' }
  /** The agents' statuses changed; ``live`` is whether any agent is still mid-turn. */
  | { type: 'report'; live: boolean }
  /** The server's word on whether the turn runs: a history page, a mode switch reply. */
  | { type: 'snapshot'; live: boolean }
  /** The turn failed, or could not start (the send or compact was refused). */
  | { type: 'end' }
  /** The sidebar row was patched to running. */
  | { type: 'row_marked' }
  /** The sidebar row may no longer say running (patched off, or the feed reattached). */
  | { type: 'row_unmarked' }
  /** A switch to another session, or a new draft. */
  | { type: 'reset' }

export const RUN_IDLE: SessionRun = { kind: 'idle' }

const running = (rowMarked = false): SessionRun => ({ kind: 'running', rowMarked })
const toIdle = (): SessionRun => RUN_IDLE

export const runMachine = defineMachine<SessionRun, RunEvent>('session run', {
  idle: {
    start: () => running(),
    report: (s, e) => (e.live ? running() : s),
    snapshot: (s, e) => (e.live ? running() : s),
    // A failure report or a refused send after the turn already ended.
    end: (s) => s,
    // The feed reattached, or a stopped row was patched again: nothing to forget.
    row_unmarked: (s) => s,
    reset: toIdle,
  },
  running: {
    start: (s) => s,
    report: (s, e) => (e.live ? s : RUN_IDLE),
    snapshot: (s, e) => (e.live ? s : RUN_IDLE),
    end: toIdle,
    row_marked: () => running(true),
    row_unmarked: () => running(false),
    reset: toIdle,
  },
})

/** True while a turn is live in this session: Stop applies and Undo waits. */
export function isRunLive(run: SessionRun): boolean {
  return run.kind === 'running'
}

/** A session run for a store seed: live or idle. */
export function runOf(live: boolean): SessionRun {
  return live ? running() : RUN_IDLE
}

type RunDraft = Pick<AgentStore, 'sessionRun' | 'sessionId' | 'cacheInvalidations'>

export function applyRun(draft: Pick<AgentStore, 'sessionRun'>, event: RunEvent): void {
  draft.sessionRun = runMachine.transition(draft.sessionRun, event)
}

/** Tell the sidebar row the session runs, once per turn. Only while a turn is live. */
export function markRowRunning(draft: RunDraft): void {
  const run = draft.sessionRun
  if (!draft.sessionId || run.kind !== 'running' || run.rowMarked) return
  applyRun(draft, { type: 'row_marked' })
  draft.cacheInvalidations.push({ kind: 'session_running', sessionId: draft.sessionId, running: true })
}

/** Tell the sidebar row the session no longer runs. */
export function markRowStopped(draft: RunDraft, sessionId: string | null = draft.sessionId): void {
  applyRun(draft, { type: 'row_unmarked' })
  if (sessionId) draft.cacheInvalidations.push({ kind: 'session_running', sessionId, running: false })
}

/**
 * Statuses that mean "this agent's turn has not ended yet". A lead suspended
 * on ``ask_user`` emits no tokens but must still read as live, or the UI
 * would look finished with a question card still on screen.
 */
const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(['working', 'waiting_input'])

export function isLiveStatus(status: SessionStatus): boolean {
  return LIVE_STATUSES.has(status)
}

/** True when any agent in the map is still mid-turn. */
export function anyAgentLive(streams: Record<string, AgentStream>): boolean {
  return Object.values(streams).some((s) => isLiveStatus(s.status))
}

/** The one writer of an agent's status. */
export function setAgentStatus(stream: AgentStream, status: SessionStatus): void {
  stream.status = status
}

/** Re-read the run from the agents after their statuses changed. */
export function reportAgents(draft: Pick<AgentStore, 'sessionRun' | 'agentStreams'>): void {
  applyRun(draft, { type: 'report', live: anyAgentLive(draft.agentStreams) })
}

/** What a history page says about the run, against what this client showed. */
export interface SnapshotInput {
  /** The server says the lead's turn runs (``history.lead.running``). */
  leadRunning: boolean
  /** The server says a member's turn runs. */
  memberRunning: boolean
  /** A question is open after this page (restored or live). */
  awaitingAnswer: boolean
  /** The lead's live stream holds content newer than the page, so it stays. */
  leadKeepsLive: boolean
  /** This client showed a live turn when the page was read. */
  believedRunning: boolean
  /** The lead's status before the page lands. */
  leadStatus: SessionStatus
}

export interface SnapshotVerdict {
  /** The run event to apply, or ``null`` to keep the run as live frames left it. */
  run: RunEvent | null
  /** The lead's status after the page, or ``null`` to keep it. */
  leadStatus: SessionStatus | null
  /** Patch the sidebar row: it runs, it stopped, or leave it. */
  row: 'running' | 'stopped' | null
}

/**
 * The run after a history page lands (``loadSession``), decided from what
 * the page says and what this client showed when it was read, never from
 * the flags the page is about to correct.
 *
 * - Live content newer than the page outranks it: the run and the lead's
 *   status stay as the live frames left them, except that a lead the client
 *   still showed running reads as working when the server agrees (the page
 *   may have just committed the bubble that showed the send was pending).
 * - Otherwise the page decides. A durable open question keeps the turn live
 *   and the lead waiting, even when the stream store forgot the turn after a
 *   daemon restart.
 * - The sidebar row follows: marked running when the turn runs, cleared when
 *   the client believed it ran and the page says it ended. A session waiting
 *   on an answer is left alone, or the patch would clear its needs-input mark.
 */
export function reconcileSnapshot(input: SnapshotInput): SnapshotVerdict {
  const { leadRunning, memberRunning, awaitingAnswer, leadKeepsLive, believedRunning, leadStatus } = input
  const row: SnapshotVerdict['row'] = awaitingAnswer
    ? null
    : leadRunning
      ? 'running'
      : !leadKeepsLive && believedRunning ? 'stopped' : null
  if (leadKeepsLive) {
    const resumes = leadRunning && !awaitingAnswer && believedRunning && leadStatus === 'idle'
    return { run: null, leadStatus: resumes ? 'working' : null, row }
  }
  return {
    run: { type: 'snapshot', live: leadRunning || memberRunning || awaitingAnswer },
    leadStatus: awaitingAnswer ? 'waiting_input' : leadRunning ? 'working' : 'idle',
    row,
  }
}
