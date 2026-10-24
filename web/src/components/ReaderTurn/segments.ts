/**
 * Reader mode reads a turn as its answer. The work behind it (thinking,
 * tool calls, subagent reports, and the narration between them) folds into
 * one summary row, and the files it edited are listed after the answer.
 * A report only sits inside a turn in reader mode, where ``partitionTurns``
 * folds it into the work it arrived after.
 *
 * Narration is any text with more work after it, so the answer is the text
 * after the last work. While a turn runs, text that gets followed by
 * another call moves into the fold, as it turns out to be narration.
 *
 * A compaction divider ends the work before it: the steps after it fold
 * behind a row of their own below the divider, so the work before and
 * after the compaction reads apart.
 *
 * A few blocks never fold, because the user must see or act on them:
 * interactive MCP apps, provider errors and notices, and compaction dividers.
 * An ``ask_user`` or ``submit_plan`` card stays out only while it waits on the
 * user; once answered or closed it is one more step of the work. A ``/goal``
 * claim stays out when it is the goal's outcome (checking, achieved, blocked,
 * or paused); a rejected claim the agent keeps working past folds.
 */
import type { ContentBlock } from '@/api/types'
import { isGoalOutcome, UPDATE_GOAL_TOOL } from '@/lib/goal'
import { isAgentReport } from '@/utils/turns'

import { patchFileStats } from '../ToolCall/diffUtils'
import { isFailedResult } from '../ToolCall/toolResultStatus'
import type { ChangedFileInfo } from '../WorkspacePanel/diff-helpers'

export type ReaderSegment =
  /** ``indices`` fold behind one summary row, placed where the first one was. */
  | { kind: 'work'; indices: number[] }
  | { kind: 'block'; index: number }

/** Whether an ``ask_user`` / ``submit_plan`` block's card still waits on the user. */
export type AwaitsUser = (block: ContentBlock) => boolean

/** Tools that pause the turn on the user; see ``useQuestionAwaitsUser``. */
const USER_GATED_TOOLS = new Set(['ask_user', 'submit_plan'])

function isWork(block: ContentBlock, awaitsUser: AwaitsUser): boolean {
  if (block.type === 'thinking') return true
  if (isAgentReport(block)) return true
  if (block.type !== 'tool') return false
  if (USER_GATED_TOOLS.has(block.toolName ?? '')) return !awaitsUser(block)
  if (block.toolName === UPDATE_GOAL_TOOL) return !isGoalOutcome(block)
  return !(block.extra as { mcp_app?: unknown } | null | undefined)?.mcp_app
}

/** A turn's blocks as reader mode shows them: work folds (one per compaction span), the rest in order. */
export function readerSegments(blocks: readonly ContentBlock[], awaitsUser: AwaitsUser): ReaderSegment[] {
  let lastWork = -1
  for (let i = blocks.length - 1; i >= 0 && lastWork < 0; i--) if (isWork(blocks[i], awaitsUser)) lastWork = i
  if (lastWork < 0) return blocks.map((_, index) => ({ kind: 'block', index }))

  const segments: ReaderSegment[] = []
  let work: number[] | null = null
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    // A compaction ends the work before it; later steps fold behind a row of their own.
    if (block.type === 'compaction') work = null
    if (!isWork(block, awaitsUser) && !(block.type === 'text' && index < lastWork)) {
      segments.push({ kind: 'block', index })
      continue
    }
    if (!work) {
      work = []
      segments.push({ kind: 'work', indices: work })
    }
    work.push(index)
  }
  return segments
}

export interface WorkSummary {
  reads: number
  searches: number
  fetches: number
  commands: number
  edits: number
  reports: number
  /** ``/goal`` completion claims the check did not accept. */
  checks: number
  other: number
  failed: number
  thought: boolean
}

type StepKind = Exclude<keyof WorkSummary, 'failed' | 'thought'>

const STEP_KIND: Record<string, StepKind> = {
  read: 'reads',
  grep: 'searches',
  glob: 'searches',
  lsp: 'searches',
  recall: 'searches',
  web_search: 'searches',
  web_fetch: 'fetches',
  shell: 'commands',
  bg: 'commands',
  patch: 'edits',
  [UPDATE_GOAL_TOOL]: 'checks',
}

export function summarizeWork(blocks: readonly ContentBlock[]): WorkSummary {
  const summary: WorkSummary = { reads: 0, searches: 0, fetches: 0, commands: 0, edits: 0, reports: 0, checks: 0, other: 0, failed: 0, thought: false }
  for (const block of blocks) {
    if (block.type === 'thinking' && block.content.trim()) summary.thought = true
    if (isAgentReport(block)) summary.reports += 1
    if (block.type !== 'tool') continue
    summary[STEP_KIND[block.toolName ?? ''] ?? 'other'] += 1
    if (block.toolDone && isFailedResult(block.toolResult)) summary.failed += 1
  }
  return summary
}

const count = (n: number, one: string, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : '')

/** e.g. "6 reads, 3 searches, 4 commands, 2 edits"; empty when nothing ran. */
export function workSummaryDetail(summary: WorkSummary): string {
  return [
    count(summary.reads, 'read'),
    count(summary.searches, 'search', 'searches'),
    count(summary.fetches, 'fetch', 'fetches'),
    count(summary.commands, 'command'),
    count(summary.edits, 'edit'),
    count(summary.reports, 'report'),
    count(summary.checks, 'goal check'),
    summary.other ? `${summary.other} other` : '',
  ].filter(Boolean).join(', ')
}

const STATUS = { add: 'A', update: 'M', delete: 'D' } as const

/**
 * Files the turn's successful ``patch`` calls edited, summed per file in the
 * order first touched. A file the turn both created and deleted is dropped.
 * Edits made through the shell are not visible here.
 */
export function turnChangedFiles(blocks: readonly ContentBlock[]): ChangedFileInfo[] {
  const files = new Map<string, ChangedFileInfo>()
  for (const block of blocks) {
    if (block.type !== 'tool' || block.toolName !== 'patch' || !block.toolDone || isFailedResult(block.toolResult)) continue
    for (const stat of patchFileStats(block.toolArgs)) {
      const status = STATUS[stat.kind]
      const prev = files.get(stat.path)
      if (!prev) {
        files.set(stat.path, { path: stat.path, status, additions: stat.additions, deletions: stat.deletions })
        continue
      }
      if (prev.status === 'A' && status === 'D') {
        files.delete(stat.path)
        continue
      }
      prev.additions += stat.additions
      prev.deletions += stat.deletions
      if (status === 'D') prev.status = 'D'
      else if (prev.status === 'D') prev.status = 'M'
    }
  }
  return [...files.values()]
}
