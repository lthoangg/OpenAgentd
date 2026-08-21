import { useMemo, useState } from 'react'
import { ArrowRight, Trash2, PlusCircle, ChevronRight, FileEdit } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { parseDiffMeta, parsePatchText, type DiffLine, type FileDiff } from './diffUtils'
import { parsePartialJSON } from './displayText'
import { isFailedResult } from './toolResultStatus'
import { parseLspDiagnostics, LspDiagnosticsView } from '../ToolResult'

interface SingleFileDiffProps {
  path: string
  kind: 'add' | 'update' | 'delete'
  moveTo?: string
  lines: DiffLine[]
  oldStart?: number
  newStart?: number
  onCollapse?: () => void
}

function SingleFileDiff({ path, kind, moveTo, lines, oldStart = 1, newStart = 1, onCollapse }: SingleFileDiffProps) {
  const [expanded, setExpanded] = useState(true)

  const linesWithNumbers = useMemo(() => {
    let oldLineNum = oldStart
    let newLineNum = newStart
    const result: ((typeof lines)[number] & { num: number })[] = []
    for (const line of lines) {
      if (line.oldStart !== undefined) oldLineNum = line.oldStart
      if (line.newStart !== undefined) newLineNum = line.newStart
      const num = line.type === 'removed' ? oldLineNum : newLineNum
      result.push({
        ...line,
        num,
      })
      if (line.type !== 'added') oldLineNum++
      if (line.type !== 'removed') newLineNum++
    }
    return result
  }, [lines, oldStart, newStart])

  const { additions, deletions } = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const line of lines) {
      if (line.type === 'added') additions++
      if (line.type === 'removed') deletions++
    }
    return { additions, deletions }
  }, [lines])

  const Icon = kind === 'add' ? PlusCircle : kind === 'delete' ? Trash2 : moveTo ? ArrowRight : FileEdit
  const iconColor =
    kind === 'add'
      ? 'text-(--color-success)'
      : kind === 'delete'
        ? 'text-(--color-error)'
        : moveTo
          ? 'text-(--color-accent)'
          : 'text-(--color-text-muted)'

  let badgeLabel = 'UPDATE'
  let badgeClass = 'bg-(--bg-key) text-(--color-text-2) border border-(--color-border)/50'
  if (kind === 'add') {
    badgeLabel = 'CREATE'
    badgeClass = 'bg-[var(--color-diff-add-bg)] text-[var(--color-diff-add-text)] border border-(--color-success)/20'
  } else if (kind === 'delete') {
    badgeLabel = 'DELETE'
    badgeClass = 'bg-[var(--color-diff-del-bg)] text-[var(--color-diff-del-text)] border border-(--color-error)/20'
  } else if (moveTo) {
    badgeLabel = additions > 0 || deletions > 0 ? 'MOVE & EDIT' : 'MOVE'
    badgeClass = 'bg-(--accent-purple-soft) text-(--accent-purple) border border-(--accent-purple)/20'
  }

  return (
    <div className="flex max-h-56 sm:max-h-80 flex-col overflow-hidden border-b border-(--color-border) last:border-b-0">
      {/* File Header */}
      <button
        type="button"
        onClick={() => {
          if (expanded && onCollapse) {
            onCollapse()
            return
          }
          setExpanded(!expanded)
        }}
        className="flex w-full shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--bg-sidebar) px-2.5 py-1 text-left font-mono text-[11px] font-semibold text-(--color-text-2) transition-colors hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${path}`}
      >
        <Icon size={12} className={`${iconColor} shrink-0`} />
        <Tooltip className="min-w-0">
          <TooltipTrigger className="min-w-0" render={<span className="truncate">{path}</span>} />
          <TooltipContent>{path}</TooltipContent>
        </Tooltip>
        {moveTo && (
          <>
            <ArrowRight size={12} className="shrink-0 text-(--color-text-muted)" />
            <Tooltip className="min-w-0">
              <TooltipTrigger className="min-w-0" render={<span className="truncate font-semibold text-(--color-accent)">{moveTo}</span>} />
              <TooltipContent>{moveTo}</TooltipContent>
            </Tooltip>
          </>
        )}
        {(additions > 0 || deletions > 0) && (
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] font-semibold select-none shrink-0">
            {additions > 0 && <span className="text-[var(--color-diff-add-text)]">+{additions}</span>}
            {deletions > 0 && <span className="text-[var(--color-diff-del-text)]">-{deletions}</span>}
          </span>
        )}
        <span className={`rounded-xs px-1 py-px text-[9px] font-semibold tracking-wide uppercase select-none ${badgeClass} ${additions === 0 && deletions === 0 ? 'ml-auto' : ''}`}>
          {badgeLabel}
        </span>
        <ChevronRight
          size={12}
          className={`shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ease-(--ease-out) ${expanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
      </button>

      {/* Diff Content */}
      <div
        aria-hidden={!expanded}
        className={`grid min-h-0 flex-1 transition-[grid-template-rows,opacity] duration-(--motion-base) ease-(--ease-out) ${
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="h-full touch-pan-y overflow-y-auto bg-(--bg-input) font-mono text-xs leading-relaxed">
              {linesWithNumbers.length === 0 ? (
                kind === 'delete' ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-4 font-mono text-xs text-[var(--color-diff-del-text)] bg-[var(--color-diff-del-bg)]/30 italic">
                    <Trash2 size={13} />
                    <span>File deleted</span>
                  </div>
                ) : moveTo ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-4 font-mono text-xs text-(--color-accent) bg-(--bg-key)/50 italic">
                    <ArrowRight size={13} />
                    <span>File moved to {moveTo} (no content changes)</span>
                  </div>
                ) : kind === 'add' ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-4 font-mono text-xs text-[var(--color-diff-add-text)] bg-[var(--color-diff-add-bg)]/30 italic">
                    <PlusCircle size={13} />
                    <span>Empty file created</span>
                  </div>
                ) : (
                  <div className="px-3 py-4 text-center text-(--color-text-muted) italic font-mono text-xs">
                    No content changes
                  </div>
                )
              ) : (
                <div className="min-w-0">
                  {linesWithNumbers.map((line, idx) => {
                    const isAdded = line.type === 'added'
                    const isRemoved = line.type === 'removed'

                    const lineBg = isAdded
                      ? 'bg-[var(--color-diff-add-bg)]'
                      : isRemoved
                        ? 'bg-[var(--color-diff-del-bg)]'
                        : 'bg-(--bg-input)'

                    const lineText = isAdded
                      ? 'text-[var(--color-diff-add-text)]'
                      : isRemoved
                        ? 'text-[var(--color-diff-del-text)]'
                        : 'text-(--color-text)'

                    return (
                      <div key={idx} className={`flex min-w-0 items-stretch ${lineBg} ${lineText}`}>
                        {/* Line Numbers */}
                        <div className="sticky left-0 z-[1] flex shrink-0 select-none border-r border-(--color-border)/40 bg-inherit text-right text-[10px] text-(--color-text-subtle)">
                          <span className="w-9 py-0.5 pr-1.5">{line.num}</span>
                        </div>
                        {/* Code Line */}
                        <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words px-2 py-0.5 [overflow-wrap:anywhere]">{line.value}</pre>
                      </div>
                    )
                  })}
                </div>
              )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface DiffViewProps {
  toolName: string
  args: string
  result?: string
  onCollapse?: () => void
}

/**
 * What to render, with every expensive derivation already done.
 *
 * Kept as plain data (not JSX) so it can live behind a single `useMemo`:
 * `ToolCall` re-renders this subtree once per second while the tool is still
 * running, purely to redraw its elapsed-duration label. Computing the diff in
 * the render body meant re-running an O(oldLines*newLines) LCS — plus a full
 * `parsePatchText` / `split('\n')` — on every one of those ticks, for the
 * entire lifetime of the tool call. See `ToolCall.perf.test.tsx` and
 * `DiffView.perf.test.tsx` for the regression guards.
 */
type DiffModel =
  // `variant` preserves the two distinct raw-text presentations the previous
  // inline branches used: unparseable args render in a plain block, while a
  // patch that yielded no file diffs renders in a scrollable one.
  | { kind: 'raw'; text: string; variant: 'args' | 'patch' }
  | {
      kind: 'single'
      path: string
      fileKind: 'add' | 'update'
      lines: DiffLine[]
      oldStart: number
      newStart: number
    }
  | { kind: 'files'; diffs: FileDiff[] }

export function DiffView({ toolName, args, result, onCollapse }: DiffViewProps) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(args)
    } catch {
      return parsePartialJSON(args)
    }
  }, [args])
  const diffMeta = useMemo(() => parseDiffMeta(result), [result])
  const lspData = useMemo(() => result ? parseLspDiagnostics(result) : null, [result])

  const model = useMemo<DiffModel | null>(() => {
    const hasPatchText =
      typeof parsed?.patch_text === 'string' && parsed.patch_text.trim().length > 0

    if (
      !parsed ||
      (toolName === 'patch' && !hasPatchText)
    ) {
      return { kind: 'raw', text: args, variant: 'args' }
    }

    if (toolName === 'patch') {
      const patchText = typeof parsed.patch_text === 'string' ? parsed.patch_text : ''
      const diffs = parsePatchText(patchText, diffMeta)
      return diffs.length === 0
        ? { kind: 'raw', text: patchText, variant: 'patch' }
        : { kind: 'files', diffs }
    }

    return null
  }, [toolName, args, parsed, diffMeta])

  // A rejected patch never touched disk — nothing here was actually applied.
  // Rendering `model` (derived purely from the *requested* patch_text) would
  // show the model's intended edit as if it had landed, and the diffMeta this
  // relies on for hunk line numbers is only ever emitted on success anyway.
  // Show the tool's own error instead of a diff nobody applied.
  const failed = toolName === 'patch' && isFailedResult(result)

  let viewContent: React.ReactNode = null

  if (failed) {
    viewContent = (
      <pre className="overflow-auto overscroll-contain touch-pan-y p-3 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-error)">
        {result}
      </pre>
    )
  } else if (model?.kind === 'raw') {
    viewContent =
      model.variant === 'patch' ? (
        <pre className="overflow-auto overscroll-contain touch-pan-y p-3 font-mono text-xs leading-relaxed text-(--color-text-2)">
          {model.text}
        </pre>
      ) : (
        <pre className="p-3 font-mono text-xs">{model.text}</pre>
      )
  } else if (model?.kind === 'single') {
    viewContent = (
      <div className="overflow-hidden">
        <SingleFileDiff
          path={model.path}
          kind={model.fileKind}
          lines={model.lines}
          oldStart={model.oldStart}
          newStart={model.newStart}
          onCollapse={onCollapse}
        />
      </div>
    )
  } else if (model?.kind === 'files') {
    const diffs = model.diffs
    viewContent = (
      <div className="flex flex-col overflow-hidden">
        {diffs.map((diff, idx) => (
          <SingleFileDiff
            key={idx}
            path={diff.path}
            kind={diff.kind}
            moveTo={diff.moveTo}
            lines={diff.lines}
            oldStart={diff.hunkStarts?.[0]?.oldStart ?? 1}
            newStart={diff.hunkStarts?.[0]?.newStart ?? 1}
            onCollapse={diffs.length === 1 ? onCollapse : undefined}
          />
        ))}
      </div>
    )
  }

  if (!viewContent) return null

  return (
    <div className="flex flex-col overflow-hidden">
      {viewContent}
      {lspData && <LspDiagnosticsView diagnostics={lspData.diagnostics} overflowCount={lspData.overflowCount} />}
    </div>
  )
}
