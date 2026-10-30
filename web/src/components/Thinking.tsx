/**
 * Thinking — the model's reasoning trace, as a transcript Row (DESIGN.md →
 * Transcript rows).
 *
 * While the model reasons the row reads "Thinking…" and the trace shows
 * below it as it streams. Once it is done the label goes and the trace stays
 * open: reasoning is part of the answer, not something to dig for.
 * The trace sits inline in muted italics (no quote bar), so it reads as
 * reasoning beside the answer; section headers stay upright.
 *
 * Reasoning streams from providers like OpenAI's ``/responses`` API as a
 * sequence of sections, each beginning with a bold ``**Title**`` header.
 * ``splitSections`` (see ``@/utils/thinking``) parses the raw text into
 * ordered sections; each header is rendered as a styled run above its body.
 * Inline ``**bold**`` runs inside the body are NOT Markdown-rendered —
 * reasoning is rarely complex prose; only the section headers get emphasis.
 */
import { splitSections } from '@/utils/thinking'
import { useSmoothStream } from '@/hooks/useSmoothStream'
import { MetaRow } from '@/components/ui/meta-row'

interface ThinkingProps {
  content: string
  isStreaming?: boolean
  /** How long the model reasoned, when the server recorded it. Not shown. */
  durationMs?: number
}

export function Thinking({ content, isStreaming = false }: ThinkingProps) {
  const smoothedContent = useSmoothStream(content, isStreaming)
  // Whitespace-only traces (a provider's blank first delta) would render an
  // empty, margined box.
  if (!content.trim()) return null

  const sections = splitSections(smoothedContent)

  return (
    <div className="my-1 min-w-0" data-thinking>
      {isStreaming && (
        <MetaRow>
          <span className="flex items-center gap-2 text-(--color-text-muted)">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--color-info)" />
            Thinking…
          </span>
        </MetaRow>
      )}
      <div
        data-thinking-trace
        className="selectable-text mt-1 mb-2 min-w-0 space-y-2 text-xs italic leading-relaxed text-(--color-text-muted) [overflow-wrap:anywhere]"
      >
      {sections.map((s, i) => (
        <div key={i} className="min-w-0">
          {s.header && (
            <p className="mb-1 break-words font-semibold not-italic text-(--color-text-2) [overflow-wrap:anywhere]">{s.header}</p>
          )}
          {s.body && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{s.body}</p>}
        </div>
      ))}
      </div>
    </div>
  )
}
