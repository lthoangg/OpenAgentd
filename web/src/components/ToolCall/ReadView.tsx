import { useMemo, useState } from 'react'
import { Check, Copy, FileText } from 'lucide-react'

interface ReadViewProps {
  args: string
  result: string
  onCollapse?: () => void
}

function parseArgs(args: string): { path: string } {
  try {
    const parsed = JSON.parse(args) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const path = (parsed as Record<string, unknown>).path
      if (typeof path === 'string' && path.trim()) return { path: path.trim() }
    }
  } catch {
    // Fall through to the stable fallback below.
  }
  return { path: 'file' }
}

function parseReadResult(result: string): { label: string; body: string; startLine: number } {
  const match = result.match(/^\[(\d+)-(\d+)\/(\d+)\]\n([\s\S]*)$/)
  if (!match) return { label: 'file contents', body: result, startLine: 1 }
  return {
    label: `lines ${match[1]}–${match[2]} of ${match[3]}`,
    body: match[4],
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
    <div className="flex max-h-80 flex-col overflow-y-auto overflow-x-hidden rounded-md">
      <div className="sticky top-0 z-10 flex w-full items-center border-b border-(--color-border) bg-(--bg-key) font-mono text-xs font-semibold text-(--color-text-2) shadow-sm">
        <button
          type="button"
          onClick={handleCollapse}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:text-(--color-accent) focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-all hover:bg-(--bg-card) hover:text-(--color-text-2) focus-visible:outline-2 focus-visible:outline-(--focus-ring) md:h-6 md:w-6"
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
        <div className="overflow-x-auto bg-(--bg-card) font-mono text-xs leading-relaxed">
          <div className="min-w-max">
            {lines.map((line, idx) => (
              <div key={idx} className="flex items-stretch bg-(--bg-card) text-(--color-text) hover:bg-(--bg-key)/30">
                <div className="sticky left-0 z-[1] flex shrink-0 select-none border-r border-(--color-border)/40 bg-(--bg-card) text-right text-[10px] text-(--color-text-subtle)">
                  <span className="w-9 py-0.5 pr-1.5">{startLine + idx}</span>
                </div>
                <pre className="flex-1 whitespace-pre-wrap px-2 py-0.5">{line || ' '}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
