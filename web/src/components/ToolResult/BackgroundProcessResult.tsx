/**
 * A bg (background process) result: the process list, one process's
 * status or captured output, or the error naming a PID it does not know.
 * Every form shares one header: pid, status chip, detail.
 */

import type { ReactNode } from 'react'
import { LinkifiedText } from '../FileRefLink'
import { truncateForDisplay } from '../ToolCall/displayText'
import { Chip, type ChipTone } from '@/components/ui/chip'

interface BackgroundProcess {
  pid: string
  status: string
  command: string
}

function statusTone(status: string): ChipTone {
  if (isRunning(status)) return 'info'
  if (status.startsWith('exited') || status.startsWith('stopped') || status.startsWith('no output')) return 'neutral'
  return 'error'
}

function isRunning(status: string): boolean {
  return status === 'running' || status.includes('running')
}

/** One header for every ``bg`` result: ``pid 4312`` · status chip · detail. */
function BgStatus({ pid, status, detail }: { pid?: string | null; status?: string; detail?: string }) {
  return (
    <>
      {pid && <span className="font-mono text-(--color-text)">pid {pid}</span>}
      {status && <Chip tone={statusTone(status)} spinner={isRunning(status)}>{status}</Chip>}
      {detail && <span className="font-sans text-(--color-text-muted)">{detail}</span>}
    </>
  )
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
      <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key) py-0 pr-2 pl-3 font-mono text-xs md:text-meta">
        <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 pointer-coarse:min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
          <BgStatus pid={pid} status={status} detail={[outputLabel && !status ? 'output' : null, detail].filter(Boolean).join(' · ') || undefined} />
        </button>
        {headerAction}
      </div>
      <pre className="max-h-40 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text-2) sm:max-h-64">
        <LinkifiedText text={truncateForDisplay(body)} />
      </pre>
    </div>
  )
}

export function BackgroundProcessResult({ result, headerAction, onCollapse }: { result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  if (result === 'No background processes running.') {
    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-8 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0 pr-2 pl-3 font-mono text-xs md:text-meta text-(--color-text-muted)">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 pointer-coarse:min-h-9 items-center justify-between gap-3 text-left transition-colors hover:text-(--color-text)">
            <span className="font-sans">No background processes</span>
          </button>
          {headerAction}
        </div>
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
        <div className="flex min-h-8 items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0 pr-2 pl-3 font-mono text-xs md:text-meta text-(--color-text-muted)">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 pointer-coarse:min-h-9 items-center justify-between gap-3 text-left transition-colors hover:text-(--color-text)">
            <span className="font-sans">{listRows.length} background {listRows.length === 1 ? 'process' : 'processes'}</span>
          </button>
          {headerAction}
        </div>
        <ul className="max-h-40 overflow-y-auto sm:max-h-64">
          {listRows.map((process) => (
            <li key={process.pid} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-(--color-border) px-2.5 py-2 font-mono text-xs last:border-b-0 sm:grid-cols-[4rem_5.5rem_minmax(0,1fr)] sm:items-center">
              <span className="text-(--color-text)">pid {process.pid}</span>
              <span><Chip tone={statusTone(process.status)} spinner={isRunning(process.status)}>{process.status}</Chip></span>
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
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key) py-0 pr-2 pl-3 font-mono text-xs md:text-meta">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 pointer-coarse:min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
            <BgStatus pid={pid} status={status} detail={bufferedLines ? `${bufferedLines} new ${bufferedLines === '1' ? 'line' : 'lines'}` : undefined} />
          </button>
          {headerAction}
        </div>
        {command && (
          <code className="block break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text-2)">
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
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key) py-0 pr-2 pl-3 font-mono text-xs md:text-meta">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 pointer-coarse:min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
            <BgStatus pid={pid} status={status} detail={detail} />
          </button>
          {headerAction}
        </div>
        {body && (
          <p className="px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-text-2)">
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
    const known = knownMatch ? `known: ${knownMatch[1]}` : undefined

    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key) py-0 pr-2 pl-3 font-mono text-xs md:text-meta">
          <button type="button" onClick={onCollapse} className="flex min-w-0 flex-1 pointer-coarse:min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 text-left transition-colors hover:text-(--color-text)">
            <BgStatus pid={pid} status={pid ? 'not found' : 'error'} detail={known} />
          </button>
          {headerAction}
        </div>
        <p className="px-3 py-2.5 font-mono text-xs leading-relaxed text-(--color-error)">
          {body}
        </p>
      </div>
    )
  }

  const isError =
    result.startsWith('Error:') ||
    result.includes('[Failed') ||
    result.includes('exit code 1') ||
    result.includes('exit 1') ||
    /\b(FAIL|FAILED|ERR!|Traceback)\b/i.test(result)
  return (
    <div className="relative">
      {headerAction && <div className="absolute top-0 right-1.5">{headerAction}</div>}
      <pre className={`max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words pr-10 font-mono text-xs leading-relaxed ${isError ? 'text-(--color-error)' : 'text-(--color-text-2)'}`}>
        <LinkifiedText text={truncateForDisplay(result)} />
      </pre>
    </div>
  )
}
