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
  const displayContent = isStreaming ? smoothedContent : content

  return (
    <Suspense fallback={<div className="oa-prose text-sm whitespace-pre-wrap">{displayContent}</div>}>
      <MarkdownBlockImpl content={displayContent} sessionId={sessionId} />
    </Suspense>
  )
}
