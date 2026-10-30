/**
 * Thinking — the model's reasoning trace, as a transcript Row (DESIGN.md →
 * Transcript rows).
 *
 * While the model reasons the row reads "Thinking…" and the trace shows
 * below it as it streams. Once it is done the row folds to
 * "Thought for 12.0 s ›" so a long trace does not take over the
 * transcript; the trace is one click away.
 *
 * Reasoning streams from providers like OpenAI's ``/responses`` API as a
 * sequence of sections, each beginning with a bold ``**Title**`` header.
 * ``splitSections`` (see ``@/utils/thinking``) parses the raw text into
 * ordered sections; each header is rendered as a styled run above its body.
 * Inline ``**bold**`` runs inside the body are NOT Markdown-rendered —
 * reasoning is rarely complex prose; only the section headers get emphasis.
 */
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { splitSections } from '@/utils/thinking'
import { useSmoothStream } from '@/hooks/useSmoothStream'
import { MetaRow, formatMetaDuration } from '@/components/ui/meta-row'
import { cn } from '@/lib/utils'

interface ThinkingProps {
  content: string
  isStreaming?: boolean
  /** How long the model reasoned, when the server recorded it. */
  durationMs?: number
}

export function Thinking({ content, isStreaming = false, durationMs }: ThinkingProps) {
  const smoothedContent = useSmoothStream(content, isStreaming)
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // Whitespace-only traces (a provider's blank first delta) would render an
  // empty, margined box.
  if (!content.trim()) return null

  const sections = splitSections(smoothedContent)
  const expanded = isStreaming || open
  const label = isStreaming
    ? 'Thinking…'
    : durationMs !== undefined
      ? `Thought for ${formatMetaDuration(durationMs)}`
      : 'Thought'

  const body = (
    <div
      id={bodyId}
      className="selectable-text mt-1 mb-2 min-w-0 space-y-2 border-l border-(--color-border) pl-3 text-xs leading-relaxed text-(--color-text-2) [overflow-wrap:anywhere]"
    >
      {sections.map((s, i) => (
        <div key={i} className="min-w-0">
          {s.header && (
            <p className="mb-1 break-words font-semibold text-(--color-text) [overflow-wrap:anywhere]">{s.header}</p>
          )}
          {s.body && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{s.body}</p>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="my-1 min-w-0" data-thinking>
      {isStreaming ? (
        <MetaRow>
          <span className="flex items-center gap-2 text-(--color-text-muted)">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--color-info)" />
            {label}
          </span>
        </MetaRow>
      ) : (
        <MetaRow
          as="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          meta={<ChevronRight size={12} aria-hidden className={cn('transition-transform duration-(--motion-fast)', open && 'rotate-90')} />}
        >
          <span className="text-(--color-text-muted)">{label}</span>
        </MetaRow>
      )}
      {expanded && body}
    </div>
  )
}
