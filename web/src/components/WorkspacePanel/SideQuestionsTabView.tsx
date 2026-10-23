/**
 * SideQuestionsTabView — the session's `/btw` side questions as a review-dock
 * tab: every question and answer in one list, oldest first, with Copy and
 * Stop on each and a two-press Clear for the whole thread. Like the panel
 * above the composer it replaces on desktop, nothing here enters the chat.
 *
 * The list is read only while the dock is open (``active``); the answer
 * streaming in this tab comes from ``useBtwStore`` through
 * ``useSideQuestions``.
 */
import { useEffect, useRef, useState } from 'react'
import { Copy, MessageCircleQuestion, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { copyText } from '@/components/ChatContextMenu'
import { ExchangeView } from '@/components/BtwPanel'
import { useSideQuestions, type BtwExchange } from '@/queries/useSideQuestionsQuery'
import { useBtwStore } from '@/stores/useBtwStore'
import { useToastStore } from '@/stores/useToastStore'

/** How long Clear waits for its confirming second press. */
const CLEAR_CONFIRM_MS = 3000

export interface SideQuestionsTabViewProps {
  sessionId: string | null
  /** The dock is open: read the stored side questions. */
  active: boolean
}

export function SideQuestionsTabView({ sessionId, active }: SideQuestionsTabViewProps) {
  const btw = useSideQuestions(sessionId, { countEnabled: false, listEnabled: active })
  const { exchanges } = btw
  const [confirmClear, setConfirmClear] = useState(false)
  const newestRef = useRef<HTMLElement>(null)
  const newestKey = exchanges.at(-1)?.key
  const newestQuestion = exchanges.at(-1)?.question

  useEffect(() => {
    if (!confirmClear) return
    const timer = setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirmClear])

  // A new question (or the tab opening) brings the newest exchange into view;
  // its answer then streams in below the question.
  useEffect(() => {
    if (newestKey === undefined) return
    newestRef.current?.scrollIntoView?.({ block: 'start' })
  }, [newestKey, newestQuestion])

  if (!sessionId) {
    return <EmptyState icon={MessageCircleQuestion} title="No session yet" body="Start a conversation, then ask a side question with /btw." />
  }
  const store = useBtwStore.getState()

  const onClear = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    store.clear(sessionId).catch((err: unknown) => {
      useToastStore.getState().push({ tone: 'error', title: 'Could not clear side questions', description: err instanceof Error ? err.message : String(err) })
    })
  }
  const onStop = (exchange: BtwExchange) => {
    if (exchange.live) void store.stop(sessionId)
    else if (exchange.id) void store.stopStored(sessionId, exchange.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) pl-3 pr-1.5">
        <span className="text-xs font-medium text-(--color-text)">Side questions</span>
        <span className="truncate text-[11px] text-(--color-text-subtle)">Not added to the chat</span>
        <span className="min-w-0 flex-1" aria-hidden="true" />
        <Button
          size={confirmClear ? 'xs' : 'icon-xs'}
          variant={confirmClear ? 'danger-subtle' : 'ghost'}
          aria-label={confirmClear ? 'Confirm: delete all side questions' : 'Clear side questions'}
          title={confirmClear ? undefined : 'Delete all side questions of this session'}
          disabled={exchanges.length === 0}
          onClick={onClear}
        >
          <Trash2 />
          {confirmClear && <span>Clear all</span>}
        </Button>
      </div>
      {exchanges.length === 0 ? (
        btw.isLoading ? (
          <p className="px-4 py-3 text-xs text-(--color-text-subtle)">Loading side questions…</p>
        ) : (
          <EmptyState
            icon={MessageCircleQuestion}
            title="No side questions yet"
            body="Type /btw and a question to ask one without adding it to the chat."
          />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
          {/* `oa-reading` (index.css): a maximized dock widens tables, code
              and diagrams while each exchange keeps the prose measure. */}
          <ol className="oa-reading mx-auto flex max-w-3xl flex-col divide-y divide-(--color-border-subtle) text-xs">
            {exchanges.map((exchange, i) => (
              <li key={exchange.key} className="oa-reading-measure-xs w-full">
                <article
                  ref={i === exchanges.length - 1 ? newestRef : undefined}
                  aria-label={exchange.question}
                  className="flex flex-col gap-1 px-4 py-3"
                >
                  <ExchangeView exchange={exchange} sessionId={sessionId} />
                  <div className="flex justify-end gap-0.5">
                    {exchange.status === 'streaming' && (
                      <Button size="xs" variant="ghost" onClick={() => onStop(exchange)}>
                        <Square className="size-3" />
                        Stop
                      </Button>
                    )}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Copy answer"
                      title="Copy answer as Markdown"
                      disabled={!exchange.answer}
                      onClick={() => copyText(exchange.answer)}
                    >
                      <Copy />
                    </Button>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
