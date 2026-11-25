/**
 * A background `shell` command's end report: a user row from `shell` whose
 * `extra.command_exit` says which command ended and how. The row's text is
 * what the agent reads (the outcome, the command, a caption, then the last
 * lines of output); the transcript draws it from `command_exit` instead.
 */

export interface CommandExit {
  number: number
  command: string
  description: string
  /** It ended by itself, ran into its limit, or the user stopped it. */
  end: 'exited' | 'timed_out' | 'stopped_by_user'
  succeeded: boolean
  /** `null` when a signal ended it or it never exited by itself. */
  exitCode: number | null
  ranSeconds: number
  /** Lines of output in all, and how many of the last ones the report quotes. */
  lines: number
  shownLines: number
  logPath: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * A message `shell` sent the session about its background commands: an end
 * report, or the note that a restart cut some off. Unlike a subagent's
 * report, it need not start a turn (nobody waits for a server).
 */
export function isShellNote(block: { type: string; extra?: Record<string, unknown> | null }): boolean {
  return block.type === 'user' && block.extra?.from_agent === 'shell'
}

/** How a background command ended, when the row is its end report. */
export function commandExit(extra: unknown): CommandExit | null {
  const raw = record(record(extra)?.command_exit)
  if (!raw || typeof raw.number !== 'number') return null
  return {
    number: raw.number,
    command: text(raw.command),
    description: text(raw.description),
    end: raw.end === 'timed_out' || raw.end === 'stopped_by_user' ? raw.end : 'exited',
    succeeded: raw.succeeded === true,
    exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : null,
    ranSeconds: count(raw.ran_seconds),
    lines: count(raw.lines),
    shownLines: count(raw.shown_lines),
    logPath: text(raw.log_path),
  }
}

/** The outcome as a terminal shows it: `exit 0`, `exit 101`, or why it has no exit code. */
export function commandOutcome(exit: CommandExit): { text: string; tone: 'ok' | 'error' | 'neutral' } {
  if (exit.end === 'stopped_by_user') return { text: 'stopped', tone: 'neutral' }
  if (exit.end === 'timed_out') return { text: 'timed out', tone: 'error' }
  if (exit.exitCode === null) return { text: 'failed', tone: 'error' }
  return { text: `exit ${exit.exitCode}`, tone: exit.succeeded ? 'ok' : 'error' }
}

/** The quoted output: the report after its outcome, command and caption lines. */
export function commandOutput(content: string): string {
  return content.split('\n').slice(3).join('\n')
}
