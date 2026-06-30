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

import { ExternalLink, FileText, Globe } from 'lucide-react'
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
    <ul className="space-y-2">
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
        <pre className="max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(--color-text-2)">
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
      <ul className="max-h-[calc(10*1.55em)] min-w-0 space-y-0.5 overflow-y-auto">
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
      <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--bg-sidebar) px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider text-(--color-text-muted) uppercase">
        <FileText size={12} className="shrink-0" aria-hidden />
        <span className="truncate">read</span>
        <span className="ml-auto shrink-0 font-normal normal-case tracking-normal">
          {rangeLabel}
        </span>
      </div>
      <pre className="max-h-[calc(10*1.55em)] min-w-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-(--color-text)">
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
    <pre className="max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(--color-text-2)">
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

function ToolResultInner({ toolName, result }: { toolName: string; result: string }) {
  if (WEB_SEARCH_TOOLS.has(toolName)) {
    return <WebSearchResult result={result} />
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
  // web_fetch, date, math, skill, etc.
  return <GenericResult result={result} />
}

export function ToolResult({ toolName, result }: { toolName: string; result: string }) {
  const lspData = parseLspDiagnostics(result)

  if (lspData) {
    return (
      <div className="flex flex-col gap-1">
        <ToolResultInner toolName={toolName} result={lspData.cleanText} />
        <LspDiagnosticsView diagnostics={lspData.diagnostics} overflowCount={lspData.overflowCount} />
      </div>
    )
  }

  return <ToolResultInner toolName={toolName} result={result} />
}
