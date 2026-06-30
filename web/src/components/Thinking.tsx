/**
 * Thinking — inline reasoning trace.
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
}

export function Thinking({ content, isStreaming = false }: ThinkingProps) {
  const smoothedContent = useSmoothStream(content, isStreaming)
  const sections = splitSections(smoothedContent)

  return (
    <div className="my-2 min-w-0 space-y-2 font-mono text-xs leading-relaxed text-(--color-text-2) [overflow-wrap:anywhere]">
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
}
