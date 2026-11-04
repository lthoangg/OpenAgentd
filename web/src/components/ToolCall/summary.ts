/**
 * Reads a shell result's status line (`[Succeeded]`, `[Failed — exit code 2]`)
 * so the opened row shows the output without that protocol line.
 */

export interface ShellOutcome {
  /** `null` when the process did not exit on its own (timeout, error). */
  exitCode: number | null
  /** The status line said it timed out. */
  timedOut: boolean
  /** Output after the status line. */
  body: string
}

const SHELL_STATUS = /^\[(Succeeded|Failed|Error|Timed out)([^\]]*)\]/i

/** `[Succeeded]` → exit 0; `[Failed — exit code 2]` → exit 2; otherwise `null`. */
export function parseShellOutcome(result: string | undefined): ShellOutcome | null {
  if (!result) return null
  const newline = result.indexOf('\n')
  const first = (newline >= 0 ? result.slice(0, newline) : result).trim()
  const match = first.match(SHELL_STATUS)
  if (!match) return null
  const body = newline >= 0 ? result.slice(newline + 1).trimStart() : ''
  const kind = match[1].toLowerCase()
  if (kind === 'succeeded') return { exitCode: 0, timedOut: false, body }
  if (kind === 'timed out') return { exitCode: null, timedOut: true, body }
  const code = match[2].match(/exit(?: code)?\s*(-?\d+)/i)
  return { exitCode: code ? Number(code[1]) : null, timedOut: false, body }
}
