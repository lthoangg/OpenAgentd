/**
 * The `script` tool's two text formats (see `appv3/crates/agent/src/tools/script.rs`):
 *
 * - the live output, one line per nested-call event while the script runs:
 *   `▸ 3 grep "TODO"` (started), `✓ 3 41 ms · 11 lines`, `✗ 3 error: …`;
 * - the result the model reads and history keeps:
 *   `calls (7, 1.8 s):`, a `→ name target · …` line per call, `output:` and
 *   the logs and return value, then an optional `error: …` and a
 *   `saved as …` / `not saved: …` line.
 */

export type ScriptCallStatus = 'running' | 'ok' | 'error' | 'cancelled'

/** What a saved-script run names: `count-todos {"pattern":"FIXME"}` or the path. */
export function scriptSource(parsed: Record<string, unknown>): { label: string; file: string | null } | null {
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null
  const path = typeof parsed.path === 'string' && parsed.path.trim() ? parsed.path.trim() : null
  if (!name && !path) return null
  const args = parsed.args && typeof parsed.args === 'object' && Object.keys(parsed.args).length ? ` ${JSON.stringify(parsed.args)}` : ''
  return { label: `${name ?? path}${args}`, file: path ?? (name ? `saved script ${name}` : null) }
}

export interface ScriptCall {
  name: string
  target: string
  status: ScriptCallStatus
  /** `41 ms · 11 lines`, the error text, or empty. */
  detail: string
}

export interface ScriptRun {
  calls: ScriptCall[]
  /** Calls the result counted but did not list. */
  more: number
  /** Every call the script made. */
  total: number
  seconds: number | null
  output: string
  error: string | null
  timedOut: boolean
  saved: string | null
}

const CALL_LINE = /^→ (\S+)(?: (.*?))? · (cancelled|error: [\s\S]*|\d+ ms · .*)$/

function parseCallLine(line: string): ScriptCall | null {
  const m = CALL_LINE.exec(line)
  if (!m) return null
  const [, name, target = '', tail] = m
  if (tail === 'cancelled') return { name, target, status: 'cancelled', detail: '' }
  if (tail.startsWith('error: ')) return { name, target, status: 'error', detail: tail.slice('error: '.length) }
  return { name, target, status: 'ok', detail: tail }
}

/** The finished run, or `null` when `text` is not a script result (an argument error, say). */
export function parseScriptResult(text: string | undefined): ScriptRun | null {
  if (!text) return null
  const head = /^calls \((\d+), ([\d.]+) s\):\n?/.exec(text)
  if (!head) return null
  const rest = text.slice(head[0].length)
  const outputAt = rest.startsWith('output:') ? 0 : rest.indexOf('\noutput:')
  if (outputAt < 0) return null
  const calls: ScriptCall[] = []
  let more = 0
  for (const line of rest.slice(0, outputAt).split('\n')) {
    const moreMatch = /^… (\d+) more$/.exec(line)
    if (moreMatch) {
      more = Number(moreMatch[1])
      continue
    }
    const call = parseCallLine(line)
    if (call) calls.push(call)
  }
  let body = rest.slice(outputAt === 0 ? 'output:'.length : outputAt + '\noutput:'.length).replace(/^\n/, '')
  let saved: string | null = null
  const lastBreak = body.lastIndexOf('\n')
  const lastLine = body.slice(lastBreak + 1)
  if (/^(saved as |not saved: )/.test(lastLine)) {
    saved = lastLine
    body = lastBreak < 0 ? '' : body.slice(0, lastBreak)
  }
  let error: string | null = null
  const errorAt = body.startsWith('error: ') ? 0 : body.lastIndexOf('\nerror: ')
  if (errorAt >= 0) {
    error = body.slice(errorAt === 0 ? 'error: '.length : errorAt + '\nerror: '.length)
    body = errorAt === 0 ? '' : body.slice(0, errorAt)
  }
  const output = body === '(nothing logged or returned)' ? '' : body
  return {
    calls,
    more,
    total: Number(head[1]),
    seconds: Number(head[2]),
    output,
    error,
    timedOut: error !== null && error.startsWith('stopped after '),
    saved,
  }
}

/** The calls so far, from the live output of a running script. */
export function parseScriptLive(text: string | undefined): ScriptCall[] {
  const calls = new Map<number, ScriptCall>()
  for (const line of (text ?? '').split('\n')) {
    const started = /^▸ (\d+) (\S+) ?(.*)$/.exec(line)
    if (started) {
      calls.set(Number(started[1]), { name: started[2], target: started[3], status: 'running', detail: '' })
      continue
    }
    const ended = /^([✓✗]) (\d+) (.*)$/.exec(line)
    const call = ended ? calls.get(Number(ended[2])) : undefined
    if (ended && call) {
      const failed = ended[1] === '✗'
      calls.set(Number(ended[2]), { ...call, status: failed ? 'error' : 'ok', detail: failed ? ended[3].replace(/^error: /, '') : ended[3] })
    }
  }
  return [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c)
}
