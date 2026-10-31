/**
 * Thinking — the model's reasoning trace, as a transcript Row (DESIGN.md →
 * Transcript rows).
 *
 * The trace streams in place with no label, and stays open once done:
 * reasoning is part of the answer, not something to dig for.
 * The trace sits inline in small mono text (no quote bar, no italics), so it
 * reads as reasoning beside the answer; section headers are bold.
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
      <div
        data-thinking-trace
        className="selectable-text mt-1 mb-2 min-w-0 space-y-2 font-mono text-xs leading-relaxed text-(--color-text-2) [overflow-wrap:anywhere]"
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
    </div>
  )
}
