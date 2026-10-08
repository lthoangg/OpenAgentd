/**
 * Reader mode's two additions to a turn (rules in ``segments.ts``): the row
 * standing in for the work, and the list of files the turn edited.
 *
 * The row uses the tool-call row language (mono label, trailing chevron, no
 * card), so the fold reads as one more step. Opened, the steps render as
 * they do in the detailed transcript, on a hairline. A long fold stays easy
 * to close: the open row pins to the top of the transcript while its steps
 * scroll under it, and a Collapse row ends the steps.
 *
 * While the agent works, the row reads "Working · 1m 12s · Shell: Run web
 * tests": how long the turn has run, then the step taking output (or the
 * counts so far). Only "Working" pulses, so the rest stays easy to read. A
 * turn waiting on the user is not working, so its row shows the counts.
 * Failures are counted only once the row stops working ("… · 1 failed").
 * A compaction divider ends the row before it, which then shows its counts;
 * the steps after the divider get a row of their own.
 *
 * The file list starts closed behind its "N files changed" header, so a turn
 * that touched many files still ends on its answer.
 */
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, ChevronUp } from 'lucide-react'

import type { ContentBlock } from '@/api/types'
import { cn } from '@/lib/utils'
import { FileRefContext } from '../FileRefLink'
import { FileTypeIcon } from '../FileTypeIcon'
import { formatToolLabel, subscribeLiveClock } from '../ToolCall'
import { getToolDisplay } from '../ToolCall/display'
import { ChangeCounts } from '../WorkspacePanel/ChangeCounts'
import type { ChangedFileInfo } from '../WorkspacePanel/diff-helpers'
import { isAgentReport } from '@/utils/turns'
import { summarizeWork, workSummaryDetail } from './segments'

/** What a running step is doing, as its tool row's tooltip names it. */
function stepLabel(block: ContentBlock): string {
  if (block.type === 'thinking') return 'Thinking'
  if (isAgentReport(block)) return `Report from ${String(block.extra?.from_agent)}`
  const name = block.toolName ?? ''
  const display = getToolDisplay(name, block.toolArgs)
  // A shell call without a description is known by its command.
  const command = name === 'shell' && typeof display.formattedArgs === 'string' ? display.formattedArgs.split('\n', 1)[0] : null
  const detail = display.headerTitle ?? command
  return detail ? `${formatToolLabel(name)}: ${detail}` : formatToolLabel(name)
}

/** Whole seconds, then minutes, then hours: "59s", "1m 0s", "1h 1m". */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The current time, kept fresh once a second while ``active``. */
function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    // A row that sat idle (waiting on the user) holds an old reading.
    setNow(Date.now())
    return subscribeLiveClock(setNow)
  }, [active])
  return now
}

/** The nearest ancestor that scrolls vertically, i.e. the transcript. */
function scrollContainer(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/** Both of the fold's controls; each adds its own text tone. */
const ROW_CLASS = 'group inline-flex max-w-full items-center gap-1.5 py-1 text-left font-mono text-xs transition-colors duration-(--motion-instant) pointer-coarse:min-h-9 hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40'

export function WorkSummaryRow({ blocks, live, startedAt, currentStep, forceOpen = false, children }: {
  /** The folded blocks. */
  blocks: readonly ContentBlock[]
  /** The agent is working on this turn right now. */
  live: boolean
  /** When the turn began (epoch ms); a live row counts from it. */
  startedAt?: number
  /** The step taking output right now, if the turn ends on one. */
  currentStep?: ContentBlock | null
  /** Show the steps whatever the toggle says, e.g. transcript find matched in them. */
  forceOpen?: boolean
  children: ReactNode
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const bodyId = useId()
  const rowRef = useRef<HTMLButtonElement>(null)
  // Where the row should sit in the view once the fold closes: where the
  // control the reader pressed was, so closing never scrolls them elsewhere.
  const closeAtRef = useRef<number | null>(null)
  const open = forceOpen || manualOpen
  const summary = useMemo(() => summarizeWork(blocks), [blocks])
  const detail = workSummaryDetail(summary)
  const now = useLiveNow(live)
  const elapsed = live && startedAt !== undefined && Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : null
  // Memoized so the clock's tick does not re-parse the step's arguments.
  const doing = useMemo(() => (currentStep ? stepLabel(currentStep) : detail), [currentStep, detail])

  const close = (control: HTMLElement) => {
    if (!forceOpen) closeAtRef.current = control.getBoundingClientRect().top
    setManualOpen(false)
  }

  // Closing drops everything the steps took up, so the reader would land far
  // below the row; scroll it back to where they pressed, before paint.
  useLayoutEffect(() => {
    const top = closeAtRef.current
    closeAtRef.current = null
    const row = rowRef.current
    if (open || top === null || !row) return
    const transcript = scrollContainer(row)
    const shift = row.getBoundingClientRect().top - top
    if (transcript && shift !== 0) transcript.scrollTop += shift
  }, [open])

  return (
    <div className="my-2 min-w-0">
      {/* Open, the row stays pinned while the steps scroll under it, so it can
          close them from anywhere. The page fill hides what passes beneath;
          z-11 clears in-block controls (code copy buttons are z-10) and stays
          under the composer and the overlaid dock (z-20). */}
      <div className={cn('flex', open && 'sticky top-0 z-11 bg-(--bg-page)')}>
        <button
          ref={rowRef}
          type="button"
          onClick={(event) => (open ? close(event.currentTarget) : setManualOpen(true))}
          aria-expanded={open}
          aria-controls={bodyId}
          className={cn(ROW_CLASS, 'text-(--color-text-2)')}
        >
          {live ? (
            <>
              <span className="shrink-0 font-semibold text-(--color-text) animate-pulse motion-reduce:animate-none">Working</span>
              {elapsed && <span className="shrink-0 text-(--color-text-muted)">{` · ${elapsed}`}</span>}
              {doing && <span className="min-w-0 truncate">{` · ${doing}`}</span>}
            </>
          ) : (
            <>
              <span className="min-w-0 truncate">{detail || (summary.thought ? 'Thought' : 'Worked')}</span>
              {summary.failed > 0 && <span className="shrink-0 text-(--color-error)">{` · ${summary.failed} failed`}</span>}
            </>
          )}
          <ChevronRight
            size={13}
            aria-hidden
            className={cn('shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
          />
        </button>
      </div>
      {open && (
        <div id={bodyId} className="ml-1 min-w-0 border-l border-(--color-border) pl-3">
          {children}
          <button
            type="button"
            onClick={(event) => {
              close(event.currentTarget)
              // This button goes with the steps; keep focus on the fold.
              rowRef.current?.focus({ preventScroll: true })
            }}
            aria-controls={bodyId}
            className={cn(ROW_CLASS, 'text-(--color-text-muted)')}
          >
            <ChevronUp size={13} aria-hidden className="shrink-0" />
            <span>Collapse</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** The files a finished turn edited; each opens its git diff in the review dock. */
export function TurnChangedFiles({ files }: { files: readonly ChangedFileInfo[] }) {
  const opener = useContext(FileRefContext)
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (files.length === 0) return null
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const rowClass = 'flex h-(--spacing-list-row) w-full min-w-0 items-center gap-2 px-3 text-left text-xs text-(--color-text-2)'
  const hoverClass = 'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 hover:text-(--color-text) focus-visible:bg-(--bg-key)/60 focus-visible:outline-none'

  return (
    <section aria-label="Files changed this turn" className="my-2 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn('flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-(--color-text-2) pointer-coarse:min-h-9', hoverClass)}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn('shrink-0 text-(--color-text-subtle) transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
        />
        <span>{`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`}</span>
        <span className="flex items-center gap-1.5 font-mono text-xs md:text-[11px]">
          {additions > 0 && <span className="text-(--color-diff-add-text)">+{additions}</span>}
          {deletions > 0 && <span className="text-(--color-diff-del-text)">-{deletions}</span>}
        </span>
      </button>
      {open && (
        <ul id={listId} className="divide-y divide-(--color-border-subtle) border-t border-(--color-border-subtle)">
          {files.map((file) => {
            const content = (
              <>
                <FileTypeIcon name={file.path} size={13} />
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <ChangeCounts file={file} />
              </>
            )
            const ref = { path: file.path }
            const canOpen = Boolean(opener && opener.canOpen(ref) && (opener.openDiff ? true : file.status !== 'D'))
            return (
              <li key={file.path}>
                {canOpen ? (
                  <button
                    type="button"
                    title={opener?.openDiff ? `Open diff for ${file.path}` : `Open ${file.path}`}
                    onClick={() => (opener?.openDiff ? opener.openDiff({ path: file.path, status: file.status }) : opener?.open(ref))}
                    className={cn(rowClass, hoverClass)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={rowClass}>{content}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
