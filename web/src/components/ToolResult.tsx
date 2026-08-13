/**
 * Rich tool result renderers.
 *
 * Each renderer receives the raw `result` string emitted by the backend and
 * the `toolName` so it can pick the right display strategy. Fall back to the
 * generic text view when nothing more specific applies.
 *
 * Visual language matches the `ToolCall` aside: no opaque dark fills, no
 * boxed-in containers. Results flow under the same left-rule indentation
 * as the args. When a code-like block is needed (file contents, shell
 * output), we use a quiet `--bg-key` tint and a thin border
 * rather than an overlay. Theme-aware, no hard-coded rgba.
 */

import { Check, Circle, ExternalLink, FileText, Globe, Loader2, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { truncateForDisplay } from './ToolCall/displayText'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebSearchResult {
  title?: string
  href?: string
  url?: string
  body?: string
  snippet?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJSON(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Truncate a string to `max` chars, appending "…" if cut. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** Best-effort hostname extraction without throwing. */
function hostname(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return href
  }
}

// ---------------------------------------------------------------------------
// Web search result renderer
// ---------------------------------------------------------------------------

function WebSearchResult({ result }: { result: string }) {
  const parsed = tryParseJSON(result)

  // Normalise to array
  const items: WebSearchResult[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? [parsed as WebSearchResult]
      : []

  if (items.length === 0) {
    return <GenericResult result={result} />
  }

  return (
    <ul className="max-h-40 space-y-2 overflow-y-auto pr-1 sm:max-h-64">
      {items.map((item, i) => {
        const link = item.href ?? item.url ?? ''
        const title = item.title ?? link
        const summary = item.body ?? item.snippet ?? ''

        return (
          <li key={i} className="group flex flex-col gap-0.5">
            {/* Title + link */}
            <div className="flex items-start gap-1.5">
              <Globe size={11} className="mt-0.5 shrink-0 text-(--color-info)" />
              {link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 font-mono text-xs font-semibold leading-snug break-words text-(--color-accent) underline-offset-2 hover:underline"
                >
                  {title}
                </a>
              ) : (
                <span className="min-w-0 flex-1 font-mono text-xs font-semibold leading-snug break-words text-(--color-text)">
                  {title}
                </span>
              )}
            </div>

            {/* Hostname pill */}
            {link && (
              <div className="flex items-center gap-1 pl-5">
                <ExternalLink size={9} className="text-(--color-text-muted)" />
                <span className="font-mono text-[10px] text-(--color-text-muted)">
                  {hostname(link)}
                </span>
              </div>
            )}

            {/* Snippet */}
            {summary && (
              <p className="pl-5 font-mono text-[11px] leading-relaxed text-(--color-text-2)">
                {truncate(summary, 200)}
              </p>
            )}

            {/* Divider (not after last) */}
            {i < items.length - 1 && (
              <hr className="mt-1.5 border-t border-(--color-border)" />
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Shell renderer
// ---------------------------------------------------------------------------

function ShellResult({ result }: { result: string }) {
  // First line is typically "[Succeeded]" or "[Failed — exit code N]"
  const firstNewline = result.indexOf('\n')
  const statusLine = firstNewline >= 0 ? result.slice(0, firstNewline).trim() : result.trim()
  const body = firstNewline >= 0 ? truncateForDisplay(result.slice(firstNewline + 1).trimStart()) : ''

  const success = statusLine.startsWith('[Succeeded')

  return (
    <div className="flex flex-col gap-1">
      {/* Status line — plain text, coloured by outcome */}
      <span
        className={`font-mono text-[11px] font-medium ${
          success ? 'text-(--color-success)' : 'text-(--color-error)'
        }`}
      >
        {statusLine}
      </span>

      {/* stdout / stderr output */}
      {body && (
        <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(--color-text-2)">
          {body}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filesystem renderers
// ---------------------------------------------------------------------------

function FileListResult({ result }: { result: string }) {
  // ls / glob return newline-separated paths or JSON array
  const parsed = tryParseJSON(result)
  const entries: string[] = Array.isArray(parsed)
    ? parsed.map(String)
    : truncateForDisplay(result)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-(--color-text-muted)">
        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
      </span>
      <ul className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] min-w-0 space-y-0.5 overflow-y-auto">
        {entries.map((e, i) => (
          <li
            key={i}
            className="font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-(--color-text-2)"
          >
            {e}
          </li>
        ))}
      </ul>
    </div>
  )
}

function FileReadResult({ result }: { result: string }) {
  // Detect the optional "[start-end/total]" header emitted by read when a
  // range was requested. Promote it to quiet metadata so the code block shows
  // only the actual file content.
  const match = result.match(/^\[(\d+)-(\d+)\/(\d+)\]\n([\s\S]*)$/)
  const rangeLabel = match ? `lines ${match[1]}-${match[2]} of ${match[3]}` : ''
  const body = truncateForDisplay(match ? match[4] : result)

  return (
    <div className="min-w-0 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)">
      <div className="flex min-h-8 items-center gap-2 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-0 font-mono text-[10px] font-semibold tracking-wider text-(--color-text-muted) uppercase">
        <FileText size={12} className="shrink-0" aria-hidden />
        <span className="truncate">read</span>
        <span className="ml-auto shrink-0 font-normal normal-case tracking-normal">
          {rangeLabel}
        </span>
      </div>
      <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] min-w-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-text)">
        {body}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Team message renderer
// ---------------------------------------------------------------------------

function TeamMessageResult({ result }: { result: string }) {
  const isError =
    result.startsWith('Agent(s) not found') ||
    result.startsWith('No valid recipients')

  return (
    <span
      className={`font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap ${
        isError ? 'text-(--color-error)' : 'text-(--color-text-2)'
      }`}
    >
      {result}
    </span>
  )
}

function TeamManageResult({ result }: { result: string }) {
  const cleanValue = (value: string) => {
    if (value.startsWith('[') && value.endsWith(']')) {
      try {
        const parsed = JSON.parse(value.replace(/'/g, '"'))
        if (Array.isArray(parsed)) {
          return parsed.join(', ')
        }
      } catch {
        return value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
          .join(', ')
      }
    }
    return value
  }

  const groups = result
    .split(/\.\s+/)
    .map((part) => part.trim().replace(/\.$/, ''))
    .filter(Boolean)
    .map((part) => {
      const [label, ...rest] = part.split(':')
      return {
        label: label.trim(),
        value: cleanValue(rest.join(':').trim()),
      }
    })
    .filter((group) => group.label && group.value)

  if (groups.length === 0) {
    return <GenericResult result={result} />
  }

  return (
    <ul className="space-y-1.5">
      {groups.map((group) => {
        const isError = group.label.toLowerCase().includes('error')

        if (group.label === 'Spawnable blueprints') {
          const items = group.value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)

          return (
            <li
              key={group.label}
              className="block min-w-0 font-mono text-[11px] leading-relaxed"
            >
              <span className="text-(--color-text-muted)">{group.label}</span>
              <span className="text-(--color-text-muted) select-none">:</span>
              <ul className="mt-1 pl-3 space-y-0.5">
                {items.map((item) => (
                  <li key={item} className="flex gap-1.5 text-(--color-text-2)">
                    <span className="text-(--color-text-muted) select-none">—</span>
                    <span className="break-words">{item}</span>
                  </li>
                ))}
              </ul>
            </li>
          )
        }

        return (
          <li
            key={`${group.label}:${group.value}`}
            className="flex min-w-0 gap-2 font-mono text-[11px] leading-relaxed"
          >
            <span
              className={`shrink-0 ${isError ? 'text-(--color-error)' : 'text-(--color-text-muted)'}`}
            >
              {group.label}
            </span>
            <span className="text-(--color-text-muted) select-none -ml-1">:</span>
            <span
              className={`min-w-0 break-words ${isError ? 'text-(--color-error)' : 'text-(--color-text-2)'}`}
            >
              {group.value}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Background-process renderer
// ---------------------------------------------------------------------------

interface BackgroundProcess {
  pid: string
  status: string
  command: string
}

function statusColor(status: string): string {
  if (status === 'running' || status.includes('running')) return 'text-(--color-success)'
  if (status.startsWith('exited') || status.startsWith('stopped') || status.startsWith('no output')) return 'text-(--color-text-muted)'
  return 'text-(--color-error)'
}

function BackgroundOutputBlock({
  pid,
  status,
  detail,
  body,
  headerAction,
  onCollapse,
  outputLabel = true,
}: {
  pid: string
  status?: string
  detail?: string
  body: string
  headerAction?: ReactNode
  onCollapse?: () => void
  outputLabel?: boolean
}) {
  return (
    <div className="min-w-0 overflow-hidden">
      <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-sidebar) py-0 pr-2 pl-3 font-mono text-[10px]">
        <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
          <span className="text-(--color-text)">PID {pid}{outputLabel ? ' output' : ''}</span>
          {status && <span className={statusColor(status)}>{status}</span>}
          {detail && <span className="text-(--color-text-muted)">{detail}</span>}
        </button>
        {headerAction}
      </div>
      <pre className="max-h-40 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-text-2) sm:max-h-64">
        {truncateForDisplay(body)}
      </pre>
    </div>
  )
}

function BackgroundProcessResult({ result, headerAction, onCollapse }: { result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  if (result === 'No background processes running.') {
    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-8 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) py-0 pr-2 pl-3 font-mono text-[10px] text-(--color-text-muted)">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left transition-colors hover:text-(--color-text)">
            <span>0 processes</span>
            <span className="hidden sm:block">background processes</span>
          </button>
          {headerAction}
        </div>
        <p className="px-2.5 py-2 font-mono text-[11px] leading-relaxed text-(--color-text-muted)">{result}</p>
      </div>
    )
  }

  const listRows = result.split('\n').slice(2).map((line): BackgroundProcess | null => {
    const [pid, status, ...command] = line.split('|').map((value) => value.trim())
    return pid && status && command.length > 0
      ? { pid, status, command: command.join('|') }
      : null
  }).filter((row): row is BackgroundProcess => row !== null)

  if (result.startsWith('PID     | Status') && listRows.length > 0) {
    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-8 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) py-0 pr-2 pl-3 font-mono text-[10px] text-(--color-text-muted)">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left transition-colors hover:text-(--color-text)">
            <span>{listRows.length} {listRows.length === 1 ? 'process' : 'processes'}</span>
            <span className="hidden sm:block">background processes</span>
          </button>
          {headerAction}
        </div>
        <ul className="max-h-40 overflow-y-auto sm:max-h-64">
          {listRows.map((process) => (
            <li key={process.pid} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-(--color-border) px-2.5 py-2 font-mono text-[11px] last:border-b-0 sm:grid-cols-[4rem_5.5rem_minmax(0,1fr)] sm:items-center">
              <span className="text-(--color-text)">PID {process.pid}</span>
              <span className={statusColor(process.status)}>{process.status}</span>
              <code className="col-span-2 break-words text-(--color-text-2) sm:col-span-1">{process.command}</code>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const outputMatch = result.match(/^PID (\d+) output:\n([\s\S]*)$/)
  const finalOutputMatch = result.match(/^PID (\d+): ([^\n]+)\nFinal output:\n([\s\S]*)$/)
  const output = outputMatch ?? finalOutputMatch
  if (output) {
    const [, pid, statusOrBody, finalBody] = output
    const body = finalBody ?? statusOrBody
    const status = finalOutputMatch?.[2]
    return <BackgroundOutputBlock pid={pid} status={status} body={body} headerAction={headerAction} onCollapse={onCollapse} />
  }

  const statusMatch = result.match(/^PID (\d+): ([^\n]+)(?:\nCommand: ([^\n]+))?(?:\nBuffered lines: (\d+))?$/)
  if (statusMatch && (statusMatch[3] || statusMatch[4])) {
    const [, pid, status, command, bufferedLines] = statusMatch
    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-sidebar) py-0 pr-2 pl-3 font-mono text-[10px]">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
            <span className="text-(--color-text)">PID {pid}</span>
            <span className={statusColor(status)}>{status}</span>
            {bufferedLines && <span className="text-(--color-text-muted)">{bufferedLines} buffered lines</span>}
          </button>
          {headerAction}
        </div>
        {command && (
          <code className="block break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-text-2)">
            {command}
          </code>
        )}
      </div>
    )
  }

  const pidStatusMatch = result.match(/^PID (\d+): ([^\n]+)(?:\n([\s\S]*))?$/)
  if (pidStatusMatch) {
    const [, pid, rawStatus, body] = pidStatusMatch
    const cleanStatus = rawStatus.endsWith('.') ? rawStatus.slice(0, -1) : rawStatus
    const statusPart = cleanStatus.match(/^(still running)(?: after (.*))?$/)
    const status = statusPart ? statusPart[1] : cleanStatus
    const detail = statusPart?.[2] ? `after ${statusPart[2]}` : undefined

    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-sidebar) py-0 pr-2 pl-3 font-mono text-[10px]">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
            <span className="text-(--color-text)">PID {pid}</span>
            <span className={statusColor(status)}>{status}</span>
            {detail && <span className="text-(--color-text-muted)">{detail}</span>}
          </button>
          {headerAction}
        </div>
        {body && (
          <p className="px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-text-2)">
            {body}
          </p>
        )}
      </div>
    )
  }

  const errorMatch = result.match(/^Error:\s*([\s\S]+)$/)
  if (errorMatch) {
    const body = errorMatch[1]
    const pidMatch = body.match(/PID (\d+)/)
    const pid = pidMatch ? pidMatch[1] : null
    const knownMatch = body.match(/Known PIDs: ([^\n.]+)/)
    const known = knownMatch ? `Known PIDs: ${knownMatch[1]}` : undefined

    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-sidebar) py-0 pr-2 pl-3 font-mono text-[10px]">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
            <span className="text-(--color-text)">{pid ? `PID ${pid}` : 'error'}</span>
            <span className="text-(--color-error)">{pid ? 'not found' : 'error'}</span>
            {known && <span className="text-(--color-text-muted)">{known}</span>}
          </button>
          {headerAction}
        </div>
        <p className="px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-error)">
          {body}
        </p>
      </div>
    )
  }

  const isError = result.startsWith('Error:')
  return (
    <div className="relative">
      {headerAction && <div className="absolute top-0 right-1.5">{headerAction}</div>}
      <pre className={`max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words pr-10 font-mono text-[11px] leading-relaxed ${isError ? 'text-(--color-error)' : 'text-(--color-text-2)'}`}>
        {truncateForDisplay(result)}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scheduled-task list renderer
// ---------------------------------------------------------------------------

interface ScheduledTaskRow {
  slug: string
  name: string
  schedule: string
  status: string
  runs: string
  next?: string
}

function parseScheduledTaskList(result: string): ScheduledTaskRow[] | null {
  if (!result.startsWith('Scheduled tasks (')) return null

  const rows = result.split('\n').slice(1).flatMap((line) => {
    const fields = new Map(
      line.trim().split('|').map((part) => {
        const separator = part.indexOf('=')
        return separator >= 0
          ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
          : ['', '']
      }),
    )
    const name = fields.get('name')
    const schedule = fields.get('schedule')
    const status = fields.get('status')
    const runs = fields.get('runs')
    if (!name || !schedule || !status || !runs) return []
    return [{
      slug: fields.get('slug') ?? '',
      name,
      schedule: schedule.replaceAll("'", ''),
      status,
      runs,
      next: fields.get('next'),
    }]
  })

  return rows.length > 0 ? rows : null
}

function ScheduleTaskListResult({ result }: { result: string }) {
  const rows = parseScheduledTaskList(result)
  if (!rows) return <GenericResult result={result} />

  return (
    <div className="oa-table-wrap">
      <table className="w-full min-w-max font-mono text-[11px] leading-relaxed text-(--color-text-2)">
        <thead className="border-b border-(--color-border) bg-(--bg-sidebar) text-left text-[10px] font-semibold tracking-wider text-(--color-text-muted) uppercase">
          <tr>
            <th className="px-3 py-1.5 font-semibold">Task</th>
            <th className="px-3 py-1.5 font-semibold">Schedule</th>
            <th className="px-3 py-1.5 font-semibold">Status</th>
            <th className="px-3 py-1.5 font-semibold">Runs</th>
            <th className="px-3 py-1.5 font-semibold">Next</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => (
            <tr key={task.slug || task.name} className="border-b border-(--color-border) last:border-b-0">
              <td className="px-3 py-2 align-top text-(--color-text)">
                <div>{task.name}</div>
                {task.slug && <div className="text-[10px] text-(--color-text-muted)">{task.slug}</div>}
              </td>
              <td className="px-3 py-2 align-top">{task.schedule}</td>
              <td className="px-3 py-2 align-top">{task.status}</td>
              <td className="px-3 py-2 align-top">{task.runs}</td>
              <td className="px-3 py-2 align-top">{task.next ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// todo_manage renderer — structured board-state view
// ---------------------------------------------------------------------------

interface TodoResultTask {
  taskId: string
  status: string
  priority: string
  deps: string | null
  assignedTo: string | null
  claimedBy: string | null
  content: string
  instructions: string | null
  result: string | null
}

const TODO_STATUS_ICON: Record<string, LucideIcon> = {
  completed: Check,
  cancelled: Minus,
  in_progress: Loader2,
  pending: Circle,
}

const TODO_STATUS_COLOR: Record<string, string> = {
  completed: 'text-(--color-success)',
  cancelled: 'text-(--color-text-subtle)',
  in_progress: 'text-(--color-info)',
  pending: 'text-(--color-text-muted)',
}

// Matches the backend's `_format_items` line shape:
// `[task_1] [status] (priority) deps=[…] assigned=X claimed=Y content`
const TODO_LINE_RE =
  /^\[([^\]]+)\] \[([^\]]+)\] \(([^)]+)\)(?: deps=\[([^\]]*)\])?(?: assigned=(\S+))?(?: claimed=(\S+))? (.+)$/

/** Parse the todo_manage board-state text into tasks; null when nothing matches. */
function parseTodoList(result: string): TodoResultTask[] | null {
  const tasks: TodoResultTask[] = []
  // 'instructions' / 'result' sub-lines can span multiple lines; unmatched
  // lines append to whichever field is currently open.
  let openField: 'instructions' | 'result' | null = null

  for (const line of result.split('\n')) {
    const m = line.match(TODO_LINE_RE)
    if (m) {
      tasks.push({
        taskId: m[1],
        status: m[2],
        priority: m[3],
        deps: m[4] ?? null,
        assignedTo: m[5] ?? null,
        claimedBy: m[6] ?? null,
        content: m[7],
        instructions: null,
        result: null,
      })
      openField = null
      continue
    }
    const last = tasks[tasks.length - 1]
    if (!last) return null // leading junk — not a board listing
    const sub = line.match(/^ {4}(instructions|result): (.*)$/)
    if (sub) {
      openField = sub[1] as 'instructions' | 'result'
      last[openField] = sub[2]
      continue
    }
    if (openField) {
      last[openField] = `${last[openField]}\n${line}`
      continue
    }
    return null // unrecognised line — fall back to generic text
  }
  return tasks.length > 0 ? tasks : null
}

function TodoListResult({ result }: { result: string }) {
  if (result.trim() === 'No todos.') {
    return <div className="text-[11px] text-(--color-text-muted)">No todos.</div>
  }
  const tasks = parseTodoList(result)
  if (!tasks) return <GenericResult result={result} />

  return (
    <ul className="space-y-2">
      {tasks.map((task) => {
        const Icon = TODO_STATUS_ICON[task.status] ?? Circle
        const iconColor = TODO_STATUS_COLOR[task.status] ?? 'text-(--color-text-muted)'
        const isFinished = task.status === 'completed' || task.status === 'cancelled'
        const agent = task.claimedBy ?? task.assignedTo
        return (
          <li key={task.taskId} className="flex items-start gap-2">
            <Icon
              size={13}
              className={`mt-0.5 shrink-0 ${iconColor} ${task.status === 'in_progress' ? 'animate-spin' : ''}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div
                className={`text-xs leading-relaxed break-words ${
                  isFinished ? 'text-(--color-text-muted)' : 'text-(--color-text)'
                }`}
              >
                {task.content}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-(--color-text-muted)">
                <span>{task.taskId}</span>
                <span>{task.status}</span>
                {agent && <span>{agent}</span>}
                {task.deps && <span>deps: {task.deps}</span>}
              </div>
              {task.instructions && (
                <div className="mt-1 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-(--color-text-muted)">
                  <span className="font-semibold">instructions:</span> {task.instructions}
                </div>
              )}
              {task.result && (
                <div className="mt-1 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-(--color-text-2)">
                  <span className="font-semibold">result:</span> {task.result}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// LSP navigation renderer
// ---------------------------------------------------------------------------

interface LspLocation {
  name: string | null
  path: string
  position: string
}

function parseLspLocations(result: string): LspLocation[] {
  return result
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [namePart, locationPart = namePart] = line.includes(' | ')
        ? line.split(' | ', 2)
        : [line]
      const match = locationPart.match(/^(.*):(\d+:\d+)$/)
      if (!match) return []
      return [{
        name: line.includes(' | ') ? namePart : null,
        path: match[1],
        position: match[2],
      }]
    })
}

function lspCountLabel(operation: string | undefined, count: number): string {
  const singular = count === 1
  if (operation === 'go_to_definition') return `${count} ${singular ? 'definition' : 'definitions'}`
  if (operation === 'find_references') return `${count} ${singular ? 'reference' : 'references'}`
  if (operation === 'document_symbol') return `${count} document ${singular ? 'symbol' : 'symbols'}`
  if (operation === 'workspace_symbol') return `${count} workspace ${singular ? 'symbol' : 'symbols'}`
  return `${count} ${singular ? 'location' : 'locations'}`
}

function lspEmptyLabel(operation: string | undefined): string {
  if (operation === 'go_to_definition') return 'No definition found.'
  if (operation === 'find_references') return 'No references found.'
  return 'No symbols found.'
}

function LspNavigationResult({
  operation,
  result,
}: {
  operation?: string
  result: string
}) {
  if (result.trim() === 'No results.') {
    return (
      <p className="font-mono text-[11px] leading-relaxed text-(--color-text-muted)">
        {lspEmptyLabel(operation)}
      </p>
    )
  }

  const locations = parseLspLocations(result)
  if (locations.length === 0) return <GenericResult result={result} />

  return (
    <div className="min-w-0">
      <p className="mb-1 font-mono text-[10px] text-(--color-text-muted)">
        {lspCountLabel(operation, locations.length)}
      </p>
      <ul className="max-h-[calc(8*1.55em)] min-w-0 space-y-1 overflow-y-auto pr-1 sm:max-h-[calc(10*1.55em)]">
        {locations.map((location, index) => (
          <li
            key={`${location.path}:${location.position}:${location.name ?? ''}:${index}`}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 font-mono text-[11px] leading-relaxed"
          >
            <span className="min-w-0 break-words text-(--color-text-2)">
              {location.name && (
                <span className="mr-2 font-semibold text-(--color-text)">
                  {location.name}
                </span>
              )}
              {location.path}
            </span>
            <span className="shrink-0 text-(--color-accent)">
              {location.position}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Generic fallback renderer
// ---------------------------------------------------------------------------

function GenericResult({ result }: { result: string }) {
  // Try pretty-print if JSON
  const parsed = tryParseJSON(result)
  const display =
    parsed !== null && typeof parsed === 'object'
      ? JSON.stringify(parsed, null, 2)
      : result
  const clipped = truncateForDisplay(display)

  return (
    <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(--color-text-2)">
      {clipped}
    </pre>
  )
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

const FILE_LIST_TOOLS = new Set(['ls', 'glob', 'grep'])
const FILE_READ_TOOLS = new Set(['read'])
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'rm'])
const SHELL_TOOLS = new Set(['shell'])
const WEB_SEARCH_TOOLS = new Set(['web_search'])
const BACKGROUND_PROCESS_TOOLS = new Set(['bg'])
const SCHEDULE_TOOLS = new Set(['schedule_task'])

export interface LspDiagnosticItem {
  filePath: string
  line: number
  character: number
  severity: 'error' | 'warning'
  message: string
  source: string
}

// eslint-disable-next-line react-refresh/only-export-components
export function parseLspDiagnostics(text: string): {
  cleanText: string
  diagnostics: LspDiagnosticItem[]
  /** Number of additional diagnostics omitted by the backend cap, if any. */
  overflowCount: number
} | null {
  const marker = '[LSP Diagnostics]\n'
  const idx = text.indexOf(marker)
  if (idx === -1) return null

  const cleanText = text.slice(0, idx).trim()
  const diagnosticsPart = text.slice(idx + marker.length)

  const diagnostics: LspDiagnosticItem[] = []
  let overflowCount = 0
  const lines = diagnosticsPart.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue

    // Backend cap summary line: "- …and 12 more in path/to/file.py"
    const moreMatch = trimmed.match(/^-\s+…and\s+(\d+)\s+more\b/)
    if (moreMatch) {
      overflowCount += parseInt(moreMatch[1], 10)
      continue
    }

    // Parse: - path/to/file.py:line:col: severity: Message (source)
    const match = trimmed.match(/^-\s+(.*?):(\d+):(\d+):\s+(error|warning):\s+(.*?)\s*\((.*?)\)$/)
    if (match) {
      diagnostics.push({
        filePath: match[1],
        line: parseInt(match[2], 10),
        character: parseInt(match[3], 10),
        severity: match[4] as 'error' | 'warning',
        message: match[5],
        source: match[6]
      })
    }
  }

  if (diagnostics.length === 0) return null
  return { cleanText, diagnostics, overflowCount }
}

export function LspDiagnosticsView({
  diagnostics,
  overflowCount = 0,
}: {
  diagnostics: LspDiagnosticItem[]
  overflowCount?: number
}) {
  if (diagnostics.length === 0) return null

  return (
    <div className="flex flex-col border-t border-(--color-error)/20 bg-(--color-error-subtle) px-2.5 py-1">
      {diagnostics.map((d, i) => {
        const isError = d.severity === 'error'
        const label = isError ? 'ERR' : 'WARN'
        const labelColor = isError ? 'text-(--color-error)' : 'text-(--color-warning)'
        const locationColor = isError ? 'text-(--color-error)/70' : 'text-(--color-warning)/70'

        return (
          <div key={i} className="flex items-baseline gap-1.5 font-mono text-[10px] leading-tight">
            <span className={`${labelColor} shrink-0 font-semibold tracking-wider uppercase`}>
              {label}
            </span>
            <span className={`${locationColor} shrink-0`}>
              {d.line}:{d.character}
            </span>
            <span className="break-words text-(--color-text)">
              {d.message}
            </span>
          </div>
        )
      })}
      {overflowCount > 0 && (
        <div className="font-mono text-[10px] leading-tight text-(--color-text-muted) italic">
          +{overflowCount} more
        </div>
      )}
    </div>
  )
}

function ToolResultInner({ toolName, operation, result, headerAction, onCollapse }: { toolName: string; operation?: string; result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  if (toolName === 'lsp') {
    return <LspNavigationResult operation={operation} result={result} />
  }
  if (WEB_SEARCH_TOOLS.has(toolName)) {
    return <WebSearchResult result={result} />
  }
  if (BACKGROUND_PROCESS_TOOLS.has(toolName)) {
    return <BackgroundProcessResult result={result} headerAction={headerAction} onCollapse={onCollapse} />
  }
  if (SCHEDULE_TOOLS.has(toolName)) {
    return <ScheduleTaskListResult result={result} />
  }
  if (SHELL_TOOLS.has(toolName)) {
    return <ShellResult result={result} />
  }
  if (FILE_LIST_TOOLS.has(toolName)) {
    return <FileListResult result={result} />
  }
  if (FILE_READ_TOOLS.has(toolName)) {
    return <FileReadResult result={result} />
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    // Write/edit results are usually short status messages — plain success style
    return <GenericResult result={result} />
  }
  if (toolName === 'team_message') {
    return <TeamMessageResult result={result} />
  }
  if (toolName === 'team_manage') {
    return <TeamManageResult result={result} />
  }
  if (toolName === 'todo_manage') {
    return <TodoListResult result={result} />
  }
  // web_fetch, date, math, skill, etc.
  return <GenericResult result={result} />
}

export function ToolResult({ toolName, operation, result, headerAction, onCollapse }: { toolName: string; operation?: string; result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  const lspData = parseLspDiagnostics(result)

  if (lspData) {
    return (
      <div className="flex flex-col gap-1">
        <ToolResultInner toolName={toolName} operation={operation} result={lspData.cleanText} headerAction={headerAction} onCollapse={onCollapse} />
        <LspDiagnosticsView diagnostics={lspData.diagnostics} overflowCount={lspData.overflowCount} />
      </div>
    )
  }

  return <ToolResultInner toolName={toolName} operation={operation} result={result} headerAction={headerAction} onCollapse={onCollapse} />
}
