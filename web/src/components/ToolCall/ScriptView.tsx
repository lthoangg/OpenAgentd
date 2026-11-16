import { memo, useMemo } from 'react'
import { tokenizeCode } from '@/utils/code-highlight'
import { cn } from '@/lib/utils'
import { CopyButton } from './CopyButton'
import { SectionHeader } from './SectionHeader'
import { parsePartialJSON } from './displayText'
import { parseScriptLive, parseScriptResult, scriptSource, type ScriptCall } from './scriptTrace'

interface ScriptViewProps {
  args: string
  result?: string
  liveOutput?: string
  done: boolean
  /** The result is on its way from the server. */
  loading?: boolean
  loadError?: string | null
  controls: string
  onCollapse: (control: HTMLElement) => void
}

const PRE = 'max-h-48 sm:max-h-72 overflow-auto touch-pan-y whitespace-pre-wrap break-words bg-(--bg-input) px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text)'

const Code = memo(function Code({ code }: { code: string }) {
  const tokens = useMemo(
    () =>
      tokenizeCode(code, 'ts').map((token, index) =>
        token.className ? (
          <span key={index} className={`th-token th-${token.className}`}>
            {token.value}
          </span>
        ) : (
          token.value
        ),
      ),
    [code],
  )
  return <code>{tokens}</code>
})

function CallLine({ call }: { call: ScriptCall }) {
  const detail =
    call.status === 'running' ? 'running…' : call.status === 'cancelled' ? 'cancelled' : call.status === 'error' ? `error: ${call.detail}` : call.detail
  return (
    <li
      data-call-status={call.status}
      className={cn(
        'grid grid-cols-[0.875rem_auto_minmax(0,1fr)_auto] items-baseline gap-x-1.5',
        call.status === 'cancelled' && 'text-(--color-text-subtle) line-through',
      )}
    >
      <span aria-hidden="true" className="text-(--color-text-muted)">→</span>
      <span className={call.status === 'error' ? 'text-(--color-error)' : 'text-(--color-text)'}>{call.name}</span>
      <span className="truncate text-(--color-text-2)">{call.target}</span>
      <span
        className={cn(
          'max-w-[24rem] truncate text-right',
          call.status === 'error' ? 'text-(--color-error)' : 'text-(--color-text-muted)',
          call.status === 'running' && 'oa-shimmer',
        )}
      >
        {detail}
      </span>
    </li>
  )
}

/**
 * The open `script` row: the code (or the saved script it ran), the nested
 * calls (live while it runs, from the result after), and what it logged or
 * returned, with any error, time-limit note and save note.
 */
export function ScriptView({ args, result, liveOutput, done, loading = false, loadError = null, controls, onCollapse }: ScriptViewProps) {
  const parsed = useMemo(() => parsePartialJSON(args), [args])
  const code = typeof parsed.code === 'string' ? parsed.code : null
  const source = useMemo(() => scriptSource(parsed), [parsed])
  const run = useMemo(() => parseScriptResult(result), [result])
  const liveCalls = useMemo(() => (run ? [] : parseScriptLive(liveOutput)), [run, liveOutput])
  const calls = run ? run.calls : liveCalls
  const total = run ? run.total : liveCalls.length
  const listed = Boolean(parsed.list)

  return (
    <>
      {code !== null && (
        <div>
          <SectionHeader label="code" controls={controls} onCollapse={onCollapse} action={<CopyButton label="Copy code" text={code} />} />
          <pre className={PRE}>
            <Code code={code} />
          </pre>
        </div>
      )}
      {code === null && source && (
        <div>
          <SectionHeader label={source.file ? `code · ${source.file}` : 'code'} controls={controls} onCollapse={onCollapse} />
          <p className="bg-(--bg-input) px-3 py-2.5 font-mono text-xs text-(--color-text-2)">{source.label}</p>
        </div>
      )}
      {!listed && (calls.length > 0 || (done && run)) && (
        <div>
          <SectionHeader label={`calls · ${total}`} controls={controls} onCollapse={onCollapse} divided={code !== null || Boolean(source)} />
          <ol aria-label="Nested tool calls" className="max-h-48 sm:max-h-72 overflow-auto bg-(--bg-input) px-3 py-2 font-mono text-xs leading-[1.75]">
            {calls.map((call, i) => (
              <CallLine key={i} call={call} />
            ))}
            {run && run.more > 0 && <li className="text-(--color-text-subtle)">… {run.more} more</li>}
          </ol>
        </div>
      )}
      {done && (
        <div>
          <SectionHeader
            label="result"
            controls={controls}
            onCollapse={onCollapse}
            divided
            action={result ? <CopyButton label="Copy result" text={result} /> : undefined}
          />
          {run?.timedOut && (
            <p role="note" className="border-b border-(--color-border) bg-(--color-warning-subtle) px-3 py-2 text-xs text-(--color-text)">
              Stopped at the time limit, so the next model call still uses the warm prompt cache. The output so far is below.
            </p>
          )}
          {result === undefined ? (
            <p className="bg-(--bg-input) px-3 py-2.5 text-xs text-(--color-text-muted)" role="status">
              {loadError ? `Couldn't load the result: ${loadError}` : loading ? 'Loading result…' : 'No result.'}
            </p>
          ) : run ? (
            <pre className={PRE}>
              {run.output || <span className="text-(--color-text-muted)">(nothing logged or returned)</span>}
              {run.error && <span className="block text-(--color-error)">error: {run.error}</span>}
              {run.saved && <span className="block text-(--color-text-muted)">{run.saved}</span>}
            </pre>
          ) : (
            <pre className={PRE}>{result}</pre>
          )}
        </div>
      )}
    </>
  )
}
