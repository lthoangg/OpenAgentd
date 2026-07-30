import { lazy, Suspense } from 'react'
import { useSmoothStream } from '@/hooks/useSmoothStream'

let markdownPreloadPromise: Promise<typeof import('@/utils/markdown')> | null = null

/** Optimistically preloads the heavy markdown rendering chunk in the background. */
// eslint-disable-next-line react-refresh/only-export-components
export function preloadMarkdownRenderer(): Promise<typeof import('@/utils/markdown')> {
  if (!markdownPreloadPromise) {
    markdownPreloadPromise = import('@/utils/markdown').catch((err) => {
      markdownPreloadPromise = null
      throw err
    })
  }
  return markdownPreloadPromise
}

const MarkdownBlockImpl = lazy(() =>
  preloadMarkdownRenderer().then((m) => ({ default: m.MarkdownBlock })),
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
      <MarkdownBlockImpl content={displayContent} sessionId={sessionId} isStreaming={isStreaming} />
    </Suspense>
  )
}
