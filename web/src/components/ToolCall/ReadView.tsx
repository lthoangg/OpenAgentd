import { useMemo, useState } from 'react'
import { Check, Copy, FileText } from 'lucide-react'
import { truncateForDisplay, parsePartialJSON } from './displayText'

interface ReadViewProps {
  args: string
  result?: string
  onCollapse?: () => void
}

function parseArgs(args: string): { path: string } {
  const parsed = parsePartialJSON(args)
  const path = parsed.path
  if (typeof path === 'string' && path.trim()) {
    return { path: path.trim() }
  }
  return { path: 'file' }
}

function parseReadResult(result?: string): { label: string; body: string; startLine: number } {
  if (!result) return { label: '', body: '', startLine: 1 }
  const match = result.match(/^\[(\d+)-(\d+)\/(\d+)\]\n([\s\S]*)$/)
  if (!match) return { label: '', body: truncateForDisplay(result), startLine: 1 }
  return {
    label: `lines ${match[1]}-${match[2]} of ${match[3]}`,
    body: truncateForDisplay(match[4]),
    startLine: Number(match[1]),
  }
}

export function ReadView({ args, result, onCollapse }: ReadViewProps) {
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  const { path } = useMemo(() => parseArgs(args), [args])
  const { label, body, startLine } = useMemo(() => parseReadResult(result), [result])
  const lines = useMemo(() => {
    const normalized = body.replace(/\r\n/g, '\n')
    const values = normalized.split('\n')
    if (values.length > 1 && values.at(-1) === '') values.pop()
    return values.length > 0 ? values : ['']
  }, [body])

  const handleCollapse = () => {
    if (onCollapse) {
      onCollapse()
      return
    }
    setExpanded(false)
  }

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex max-h-80 flex-col overflow-hidden">
      <div className="flex w-full items-center border-b border-(--color-border) bg-(--bg-sidebar) font-mono text-xs font-semibold text-(--color-text-2) shadow-sm">
        <button
          type="button"
          onClick={handleCollapse}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
          aria-expanded={expanded}
          aria-label="Collapse read result"
        >
          <FileText size={14} className="shrink-0 text-(--color-text-muted)" aria-hidden />
          <span className="truncate">{path}</span>
        </button>
        <span className="shrink-0 px-1 text-[10px] font-normal text-(--color-text-muted) uppercase">
          {label}
        </span>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void copyBody()
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40 md:h-6 md:w-6"
          aria-label="Copy read result"
          title="Copy read result"
        >
          {copied ? (
            <Check size={12} className="text-(--color-success)" aria-hidden />
          ) : (
            <Copy size={12} aria-hidden />
          )}
        </button>
      </div>

      {expanded && (
        <div className="overflow-y-auto overscroll-contain touch-pan-y bg-(--bg-input) font-mono text-xs leading-relaxed">
          <div className="min-w-0">
            {lines.map((line, idx) => (
              <div key={idx} className="flex items-stretch text-(--color-text)">
                <div className="sticky left-0 z-[1] flex shrink-0 select-none border-r border-(--color-border)/40 bg-(--bg-input) text-right text-[10px] text-(--color-text-subtle)">
                  <span className="w-9 py-0.5 pr-1.5">{startLine + idx}</span>
                </div>
                <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2 py-0.5 [overflow-wrap:anywhere]">{line || ' '}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
