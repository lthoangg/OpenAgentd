/**
 * CommandReport — a background shell command's end report in the
 * transcript. It sits where a subagent's report does (left, a muted header
 * over a card), and reads as a terminal does: the command (or what the
 * agent called it), its exit code coloured by outcome, how long it ran,
 * then the end of its output in mono. The row's own text is written for the
 * agent; this draws the same facts from `extra.command_exit`.
 */
import { Check, Copy } from 'lucide-react'

import { LinkifiedText } from '@/components/FileRefLink'
import { Button } from '@/components/ui/button'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { formatGoalDuration } from '@/lib/goal'
import { commandOutcome, commandOutput, type CommandExit } from '@/utils/command-report'
import { formatTime } from '@/utils/format'

const TONE = {
  ok: 'text-(--accent-green-text)',
  error: 'text-(--color-error)',
  neutral: 'text-(--color-text-muted)',
} as const

export function CommandReport({ exit, content, timestamp }: { exit: CommandExit; content: string; timestamp?: Date }) {
  const { copied, copy } = useCopyFeedback()
  const outcome = commandOutcome(exit)
  const output = commandOutput(content)
  const cut = exit.shownLines > 0 && exit.shownLines < exit.lines
  return (
    <div data-command-report="" className="group mb-3 flex justify-start">
      <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5 md:max-w-[85%]">
        <div className="flex max-w-full items-center gap-1.5 px-0.5 text-xs text-(--color-text-muted)">
          <span data-command-report-head="" className="flex min-w-0 items-center gap-1.5">
            <span className="text-meta text-(--color-text-subtle)">Command</span>
            <span className="min-w-0 truncate rounded-xs bg-(--bg-key)/70 px-1.5 py-0.5 font-mono text-meta font-semibold text-(--color-text)">{exit.description || exit.command}</span>
            <span className={`shrink-0 font-mono text-meta font-medium ${TONE[outcome.tone]}`}>{outcome.text}</span>
            <span className="shrink-0 text-meta text-(--color-text-subtle)">· {formatGoalDuration(exit.ranSeconds)}</span>
          </span>
          {timestamp && <span className="shrink-0 text-meta text-(--color-text-subtle)">· {formatTime(timestamp)}</span>}
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => copy(output || content)} className="ml-0.5" title="Copy output" aria-label="Copy output">
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </Button>
        </div>
        <div className="min-w-0 max-w-full rounded-sm border border-(--color-border) bg-(--bg-card) px-3.5 py-2.5">
          {output ? (
            <pre className="max-h-[calc(8*1.55em)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-text-2) sm:max-h-[calc(10*1.55em)]">
              <LinkifiedText text={output} />
            </pre>
          ) : (
            <span className="text-xs text-(--color-text-muted)">No output</span>
          )}
        </div>
        {cut && (
          <span className="px-0.5 text-meta text-(--color-text-muted)">
            Last {exit.shownLines} of {exit.lines.toLocaleString('en-US')} lines
          </span>
        )}
      </div>
    </div>
  )
}
