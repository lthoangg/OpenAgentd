/**
 * Filesystem tool results: the paths glob and grep found, and the file
 * read returned with its line range as quiet metadata.
 */

import { FileText } from 'lucide-react'
import { LinkifiedText } from '../FileRefLink'
import { truncateForDisplay } from '../ToolCall/displayText'
import { parseSearchResult } from '@/utils/search-result'
import { tryParseJSON } from './GenericResult'

const LIST_CLASS = 'max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] min-w-0 space-y-0.5 overflow-y-auto'
const ROW_CLASS = 'font-mono text-xs leading-relaxed break-words whitespace-pre-wrap'

export function FileListResult({ result }: { result: string }) {
  // glob / grep return newline-separated paths or JSON array
  const parsed = tryParseJSON(result)
  const entries: string[] = Array.isArray(parsed)
    ? parsed.map(String)
    : truncateForDisplay(result)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs md:text-meta text-(--color-text-muted)">
        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
      </span>
      <ul className={LIST_CLASS}>
        {entries.map((e, i) => (
          <li key={i} className={`${ROW_CLASS} text-(--color-text-2)`}>
            <LinkifiedText text={e} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * What `grep` found: a count of the matches, each one with the lines the
 * call asked to see around it (quieter, so the match stands out), and the
 * note the tool adds when it left matches out.
 */
export function SearchResult({ result }: { result: string }) {
  const parsed = parseSearchResult(truncateForDisplay(result))
  if (!parsed) return <FileListResult result={result} />

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs md:text-meta text-(--color-text-muted)">
        {parsed.matches.toLocaleString()} {parsed.matches === 1 ? 'match' : 'matches'}
      </span>
      <ul className={LIST_CLASS}>
        {parsed.lines.map((line, i) =>
          line.kind === 'gap' ? (
            <li key={i} data-line="gap" className="my-1 h-px bg-(--color-border)" />
          ) : (
            <li
              key={i}
              data-line={line.kind}
              className={`${ROW_CLASS} ${line.kind === 'context' ? 'text-(--color-text-muted)' : 'text-(--color-text-2)'}`}
            >
              {line.kind === 'context' ? line.text : <LinkifiedText text={line.text} />}
            </li>
          ),
        )}
      </ul>
      {parsed.note && <p className="text-xs leading-relaxed text-(--color-text-muted)">{parsed.note}</p>}
    </div>
  )
}

export function FileReadResult({ result }: { result: string }) {
  // Detect the optional "[start-end/total]" header emitted by read when a
  // range was requested. Promote it to quiet metadata so the code block shows
  // only the actual file content.
  const match = result.match(/^\[(\d+)-(\d+)\/(\d+)\]\n([\s\S]*)$/)
  const rangeLabel = match ? `Lines ${match[1]}–${match[2]} of ${match[3]}` : ''
  const body = truncateForDisplay(match ? match[4] : result)

  return (
    <div className="min-w-0 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-input)">
      <div className="flex min-h-8 items-center gap-2 border-b border-(--color-border) bg-(--bg-key) px-3 py-0 font-mono label-caps text-(--color-text-muted)">
        <FileText size={12} className="shrink-0" aria-hidden />
        <span className="truncate">read</span>
        <span className="ml-auto shrink-0 font-normal normal-case tracking-normal">
          {rangeLabel}
        </span>
      </div>
      <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] min-w-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text)">
        {body}
      </pre>
    </div>
  )
}
