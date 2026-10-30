/**
 * Reader mode's two additions to a turn (rules in ``segments.ts``): the row
 * standing in for the work, and the list of files the turn edited.
 *
 * The row uses the tool-call row language (mono label, trailing chevron, no
 * card), so the fold reads as one more step. Opened, the steps render as
 * they do in the detailed transcript, on a hairline. A long fold stays easy
 * to close: the open row pins to the top of the transcript while its steps
 * scroll under it (``useStickyFold``), and a Collapse row ends the steps. An
 * opened step pins its own header just below the row.
 *
 * While the agent works, the row reads "Working · 1m 12s · shell bun test":
 * how long the turn has run, then the step taking output (or the counts so
 * far). A blue dot marks it live; no text blinks. A
 * turn waiting on the user is not working, so its row shows the counts.
 * A compaction divider ends the row before it, which then shows its counts;
 * the steps after the divider get a row of their own.
 *
 * The file list starts closed behind its "N files changed" header, so a turn
 * that touched many files still ends on its answer; open, the header pins.
 */
import { useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, ChevronUp } from 'lucide-react'

import type { ContentBlock } from '@/api/types'
import { cn } from '@/lib/utils'
import { Collapsible } from '@/components/ui/collapsible'
import { PINNED_HEADER, useStickyFold } from '@/hooks/useStickyFold'
import { FileRefContext } from '../FileRefLink'
import { FileTypeIcon } from '../FileTypeIcon'
import { subscribeLiveClock } from '../ToolCall'
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
  const detail = (display.headerTitle ?? command)?.split('\n', 1)[0]
  return detail ? `${name} ${detail}` : name
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

/** Both of the fold's controls; each adds its own text tone. */
const ROW_CLASS = 'group inline-flex max-w-full items-center gap-1.5 py-1 text-left font-mono text-xs transition-colors duration-(--motion-instant) pointer-coarse:min-h-9 hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)'
/** The row's height (``ROW_CLASS``: one ``text-xs`` line plus ``py-1``, or ``min-h-9`` on touch), so an opened step pins below it. */
const BELOW_ROW = '[--fold-top:1.5rem] pointer-coarse:[--fold-top:2.25rem]'

export function WorkSummaryRow({ blocks, live, startedAt, currentStep, children }: {
  /** The folded blocks. */
  blocks: readonly ContentBlock[]
  /** The agent is working on this turn right now. */
  live: boolean
  /** When the turn began (epoch ms); a live row counts from it. */
  startedAt?: number
  /** The step taking output right now, if the turn ends on one. */
  currentStep?: ContentBlock | null
  children: ReactNode
}) {
  const { open, setOpen, close, anchorRef: rowRef } = useStickyFold()
  const bodyId = useId()
  const summary = useMemo(() => summarizeWork(blocks), [blocks])
  const detail = workSummaryDetail(summary)
  const now = useLiveNow(live)
  const elapsed = live && startedAt !== undefined && Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : null
  // Memoized so the clock's tick does not re-parse the step's arguments.
  const doing = useMemo(() => (currentStep ? stepLabel(currentStep) : detail), [currentStep, detail])

  return (
    <div className="my-2 min-w-0">
      {/* Open, the row stays pinned while the steps scroll under it, so it can
          close them from anywhere. */}
      <div className={cn('flex', open && cn(PINNED_HEADER, 'bg-(--bg-page)'))}>
        <button
          ref={rowRef}
          type="button"
          onClick={(event) => (open ? close(event.currentTarget) : setOpen(true))}
          aria-expanded={open}
          aria-controls={bodyId}
          className={cn(ROW_CLASS, 'text-(--color-text-2)')}
        >
          {live ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-(--color-info)" aria-hidden="true" />
              <span className="shrink-0 font-semibold text-(--color-text)">Working</span>
              {elapsed && <span className="shrink-0 text-(--color-text-muted)">{` · ${elapsed}`}</span>}
              {doing && <span className="min-w-0 truncate">{` · ${doing}`}</span>}
            </>
          ) : (
            <span className="min-w-0 truncate">{detail || (summary.thought ? 'Thought' : 'Worked')}</span>
          )}
          <ChevronRight
            size={13}
            aria-hidden
            className={cn('shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
          />
        </button>
      </div>
      {open && (
        <div id={bodyId} className={cn('ml-1 min-w-0 border-l border-(--color-border) pl-3', BELOW_ROW)}>
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
  const { open, setOpen, close, anchorRef } = useStickyFold()
  const listId = useId()
  if (files.length === 0) return null
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const rowClass = 'flex h-(--spacing-list-row) w-full min-w-0 items-center gap-2 px-3 text-left text-xs text-(--color-text-2)'
  const hoverClass = 'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 hover:text-(--color-text) focus-key:bg-(--bg-key)/60 focus-visible:outline-none'

  return (
    // ``overflow-clip``, not ``hidden``: a clipping scroller would stop the open header pinning.
    <section aria-label="Files changed this turn" className="my-2 overflow-clip rounded-sm border border-(--color-border) bg-(--bg-card)">
      <button
        ref={anchorRef}
        type="button"
        onClick={(event) => (open ? close(event.currentTarget) : setOpen(true))}
        aria-expanded={open}
        aria-controls={listId}
        className={cn('flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-(--color-text-2) pointer-coarse:min-h-9', open && cn(PINNED_HEADER, 'bg-(--bg-card)'), hoverClass)}
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
      <Collapsible open={open}>
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
      </Collapsible>
    </section>
  )
}
