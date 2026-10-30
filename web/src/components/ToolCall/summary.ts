/**
 * The short result a finished tool row shows after its target (DESIGN.md →
 * Transcript rows, audit H2): `14 matches in 6 files`, `1 failed, 11 passed`,
 * `4 tasks · 1 in progress`. Parsed from the raw result text the tool
 * returned; `null` when nothing short and true can be said, so the row shows
 * only the name and target.
 *
 * Also reads a shell result's status line into an exit code, which the row
 * shows as a chip in its meta column instead of `[Succeeded]` in the output.
 */
import { canonicalToolName } from '@/utils/tool-names'

export interface ToolRowSummary {
  text: string
  /** Red text: the call failed and this is its error. */
  error?: boolean
}

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

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function firstLine(text: string): string {
  return text.trimStart().split('\n', 1)[0]?.trim() ?? ''
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** `48 passed`, `1 failed, 11 passed` from common test-runner summaries. */
function testCounts(output: string): string | null {
  const tail = output.slice(-4000)
  const passed = [...tail.matchAll(/(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/gi)].at(-1)
  const failed = [...tail.matchAll(/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?\b/gi)].at(-1)
  const parts: string[] = []
  if (failed && Number(failed[1]) > 0) parts.push(`${Number(failed[1])} failed`)
  if (passed) parts.push(`${Number(passed[1])} passed`)
  return parts.length > 0 ? parts.join(', ') : null
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const TODO_LINE = /^\[[^\]]+\] \[([^\]]+)\] \([^)]+\)/

export function toolRowSummary(rawName: string, result: string | undefined, failed: boolean): ToolRowSummary | null {
  if (!result) return null
  const name = canonicalToolName(rawName)

  // Shell: never an error summary or exit status — the agent reads and fixes
  // a failed command. Only test counts (from the output's tail) are worth a
  // glance, and nothing here scans the whole output, which can be megabytes.
  if (name === 'shell') {
    const outcome = parseShellOutcome(result)
    if (!outcome) return null
    const counts = testCounts(outcome.body)
    if (counts) return { text: counts }
    return outcome.body.trim() ? null : { text: 'no output' }
  }

  if (failed) {
    const line = firstLine(result).replace(/^error:\s*/i, '')
    return line ? { text: clip(line, 60), error: true } : null
  }

  if (name === 'grep') {
    const lines = nonEmptyLines(result)
    if (lines.length === 0 || /^no matches/i.test(lines[0])) return { text: 'no matches' }
    const hits = lines.filter((line) => /^[^:\s][^:]*:\d+[:-]/.test(line))
    if (hits.length === 0) return { text: plural(lines.length, 'line') }
    const files = new Set(hits.map((line) => line.slice(0, line.search(/:\d+[:-]/))))
    return { text: `${plural(hits.length, 'match', 'matches')} in ${plural(files.size, 'file')}` }
  }

  if (name === 'glob') {
    const lines = nonEmptyLines(result)
    if (lines.length === 0 || /^no (files|matches)/i.test(lines[0])) return { text: 'no files' }
    return { text: plural(lines.length, 'file') }
  }

  if (name === 'read') {
    const range = result.match(/^\[(\d+)-(\d+)\/(\d+)\]/)
    if (range) return { text: `L${range[1]}–${range[2]} of ${Number(range[3]).toLocaleString()}` }
    return null
  }

  if (name === 'todo') {
    const statuses = result.split('\n').flatMap((line) => {
      const match = line.match(TODO_LINE)
      return match ? [match[1]] : []
    })
    if (statuses.length > 0) {
      const running = statuses.filter((status) => status === 'in_progress').length
      return { text: running > 0 ? `${plural(statuses.length, 'task')} · ${running} in progress` : plural(statuses.length, 'task') }
    }
    const outcome = firstLine(result)
    return outcome ? { text: clip(outcome, 60) } : null
  }

  if (name === 'web_fetch') {
    return { text: formatBytes(new TextEncoder().encode(result).length) }
  }

  return null
}
