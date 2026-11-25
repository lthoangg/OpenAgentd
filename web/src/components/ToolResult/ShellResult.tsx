/**
 * A shell result: the exit code coloured by outcome (or, for a background
 * call, that its command was started), then the command's output with file
 * paths made openable.
 */

import { LinkifiedText } from '../FileRefLink'
import { truncateForDisplay } from '../ToolCall/displayText'
import { parseBackgroundStart, parseShellOutcome } from '../ToolCall/summary'

export function ShellResult({ result }: { result: string }) {
  // First line is typically "[Succeeded]" or "[Failed — exit code N]"
  const firstNewline = result.indexOf('\n')
  const statusLine = firstNewline >= 0 ? result.slice(0, firstNewline).trim() : result.trim()
  const body = firstNewline >= 0 ? truncateForDisplay(result.slice(firstNewline + 1).trimStart()) : ''

  const success = statusLine.startsWith('[Succeeded')
  // A background call has no outcome yet: its command only started.
  const started = parseBackgroundStart(result)
  // The bracketed line is the tool's protocol; the screen shows the exit code, as a terminal does.
  const outcome = parseShellOutcome(result)
  const statusText = started ? `started · command ${started.number}`
    : !outcome ? statusLine
      : outcome.exitCode !== null ? `exit ${outcome.exitCode}`
        : statusLine.replace(/^\[|\]$/g, '')
  const tone = started ? 'text-(--color-text-muted)' : success ? 'text-(--accent-green-text)' : 'text-(--color-error)'

  return (
    <div className="flex flex-col gap-1">
      {/* Status line — plain text, coloured by outcome */}
      <span className={`font-mono text-meta font-medium ${tone}`}>
        {statusText}
      </span>

      {/* stdout / stderr output */}
      {body && (
        <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-text-2)">
          <LinkifiedText text={body} />
        </pre>
      )}
    </div>
  )
}
