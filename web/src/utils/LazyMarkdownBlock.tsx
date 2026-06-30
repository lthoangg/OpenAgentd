import { lazy, Suspense } from 'react'
import { useSmoothStream } from '@/hooks/useSmoothStream'

const MarkdownBlockImpl = lazy(() =>
  import('@/utils/markdown').then((m) => ({ default: m.MarkdownBlock })),
)

interface LazyMarkdownBlockProps {
  content: string
  sessionId?: string
  isStreaming?: boolean
}

export function LazyMarkdownBlock({ content, sessionId, isStreaming = false }: LazyMarkdownBlockProps) {
  const smoothedContent = useSmoothStream(content, isStreaming)

  // While streaming, skip the markdown parser entirely — re-parsing the full AST
  // on every animation frame is expensive. Plain-text is good enough mid-stream.
  if (isStreaming) {
    return <div className="oa-prose text-sm whitespace-pre-wrap">{smoothedContent}</div>
  }

  return (
    <Suspense fallback={<div className="oa-prose text-sm whitespace-pre-wrap">{content}</div>}>
      <MarkdownBlockImpl content={content} sessionId={sessionId} />
    </Suspense>
  )
}
