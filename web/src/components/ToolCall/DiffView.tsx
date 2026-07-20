import { useMemo, useState } from 'react'
import { FileCode, ArrowRight, Trash2, PlusCircle, ChevronRight } from 'lucide-react'
import { diffLines, parseDiffMeta, parsePatchText, type DiffLine } from './diffUtils'
import { parsePartialJSON } from './displayText'
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
    return lines.map((line) => {
      if (line.oldStart !== undefined) oldLineNum = line.oldStart
      if (line.newStart !== undefined) newLineNum = line.newStart
      const num = line.type === 'removed' ? oldLineNum : newLineNum
      const r = {
        ...line,
        num,
      }
      if (line.type !== 'added') oldLineNum++
      if (line.type !== 'removed') newLineNum++
      return r
    })
  }, [lines, oldStart, newStart])

  const Icon = kind === 'add' ? PlusCircle : kind === 'delete' ? Trash2 : FileCode
  const iconColor =
    kind === 'add'
      ? 'text-(--color-success)'
      : kind === 'delete'
        ? 'text-(--color-error)'
        : 'text-(--color-text-muted)'

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
          setExpanded((value) => !value)
        }}
        className="flex w-full shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-1.5 text-left font-mono text-xs font-semibold text-(--color-text-2) shadow-sm transition-colors hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${path}`}
      >
        <Icon size={14} className={iconColor} />
        <span className="truncate">{path}</span>
        {moveTo && (
          <>
            <ArrowRight size={12} className="text-(--color-text-muted)" />
            <span className="truncate text-(--color-accent)">{moveTo}</span>
          </>
        )}
        <span className="ml-auto text-[10px] font-normal text-(--color-text-muted) uppercase">
          {kind}
        </span>
        <ChevronRight
          size={13}
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
                <div className="px-3 py-4 text-center text-(--color-text-muted) italic">
                  No content changes
                </div>
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

  const hasPath = typeof parsed?.path === 'string' && parsed.path.trim().length > 0
  const hasPatchText = typeof parsed?.patch_text === 'string' && parsed.patch_text.trim().length > 0

  let viewContent: React.ReactNode = null

  if (!parsed || (toolName === 'edit' && !hasPath) || (toolName === 'write' && !hasPath) || (toolName === 'patch' && !hasPatchText)) {
    viewContent = <pre className="p-3 font-mono text-xs">{args}</pre>
  } else if (toolName === 'edit') {
    const path = typeof parsed.path === 'string' ? parsed.path : 'unknown'
    const oldStr = typeof parsed.old_string === 'string' ? parsed.old_string : ''
    const newStr = typeof parsed.new_string === 'string' ? parsed.new_string : ''
    const lines = diffLines(oldStr, newStr)

    viewContent = (
      <div className="overflow-hidden">
        <SingleFileDiff
          path={path}
          kind="update"
          lines={lines}
          oldStart={diffMeta?.old_start ?? 1}
          newStart={diffMeta?.new_start ?? 1}
          onCollapse={onCollapse}
        />
      </div>
    )
  } else if (toolName === 'write') {
    const path = typeof parsed.path === 'string' ? parsed.path : 'unknown'
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    const lines = content.replace(/\r\n/g, '\n').split('\n').map((line: string) => ({ type: 'added' as const, value: line }))

    viewContent = (
      <div className="overflow-hidden">
        <SingleFileDiff path={path} kind="add" lines={lines} onCollapse={onCollapse} />
      </div>
    )
  } else if (toolName === 'patch') {
    const patchText = typeof parsed.patch_text === 'string' ? parsed.patch_text : ''
    const diffs = parsePatchText(patchText, diffMeta)

    if (diffs.length === 0) {
      viewContent = (
        <pre className="overflow-auto overscroll-contain touch-pan-y p-3 font-mono text-xs leading-relaxed text-(--color-text-2)">
          {patchText}
        </pre>
      )
    } else {
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
  }

  if (!viewContent) return null

  return (
    <div className="flex flex-col overflow-hidden">
      {viewContent}
      {lspData && <LspDiagnosticsView diagnostics={lspData.diagnostics} overflowCount={lspData.overflowCount} />}
    </div>
  )
}
