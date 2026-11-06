import type { BtwExchange } from '@/queries/useSideQuestionsQuery'
import { MarkdownBlock } from '@/utils/markdown'

/** One side question and its answer (also the dock tab's rows). */
export function ExchangeView({ exchange, sessionId }: { exchange: BtwExchange; sessionId: string }) {
  const streaming = exchange.status === 'streaming'
  return (
    <div className="flex flex-col gap-1.5">
      <p className="whitespace-pre-wrap break-words text-(--color-text-muted)">{exchange.question}</p>
      {exchange.answer ? (
        <MarkdownBlock content={exchange.answer} sessionId={sessionId} isStreaming={streaming && exchange.live} />
      ) : streaming ? (
        <p role="status"><span className="oa-shimmer">Thinking…</span></p>
      ) : null}
      {exchange.status === 'error' && (
        <p role="alert" className="text-(--color-error)">{exchange.error || 'The side question failed.'}</p>
      )}
      {exchange.status === 'stopped' && <p className="text-(--color-text-muted)">Stopped.</p>}
    </div>
  )
}
