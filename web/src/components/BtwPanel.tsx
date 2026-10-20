/**
 * BtwPanel — `/btw` side questions above the composer: the question, its
 * answer streaming in, and the earlier ones to step back through. Side
 * questions are kept beside the session, never in its chat.
 *
 * On desktop with a workspace the review dock's BTW tab shows them instead
 * (``SideQuestionsTabView``); this is then only the reopen chip
 * (``chipOnly``), which opens that tab through ``onReopen``.
 *
 * Closing only hides the panel; Clear deletes. While it is closed and the
 * session has side questions, a small chip reopens it (so does a bare
 * `/btw` or Cmd+K → Side Questions).
 */
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, MessageCircleQuestion, Square, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyText } from '@/components/ChatContextMenu'
import { useSideQuestions, type BtwExchange } from '@/queries/useSideQuestionsQuery'
import { useBtwStore } from '@/stores/useBtwStore'
import { useToastStore } from '@/stores/useToastStore'
import { MarkdownBlock } from '@/utils/markdown'

/** How long Clear waits for its confirming second press. */
const CLEAR_CONFIRM_MS = 3000

interface BtwPanelProps {
  sessionId: string | null
  /** Fetch the stored count for the reopen chip (the session has messages). */
  countEnabled: boolean
  /** Never show the panel, only the chip (the dock shows side questions). */
  chipOnly?: boolean
  /** What the chip does; defaults to reopening this panel. */
  onReopen?: () => void
}

export function BtwPanel({ sessionId, countEnabled, chipOnly = false, onReopen }: BtwPanelProps) {
  const btw = useSideQuestions(sessionId, { countEnabled, listEnabled: chipOnly ? false : undefined })
  const [confirmClear, setConfirmClear] = useState(false)
  const { exchanges, view } = btw
  const open = btw.open && !chipOnly

  useEffect(() => {
    if (!confirmClear) return
    const timer = setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirmClear])

  if (!sessionId) return null
  const store = useBtwStore.getState()

  if (!open) {
    if (btw.total <= 0) return null
    return (
      <button
        type="button"
        onClick={() => (onReopen ? onReopen() : store.reopen(sessionId))}
        aria-label={`Show side questions (${btw.total})`}
        title="Side questions (/btw)"
        // Floats over the transcript like the jump-to-latest chip, so the
        // composer never moves for it.
        className="pointer-events-auto absolute bottom-full right-3 z-10 mb-3 flex h-7 items-center gap-1 rounded-full border border-(--color-border) bg-(--bg-card) px-2 text-xs text-(--color-text-2) shadow-(--shadow-depth) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) active:scale-95 motion-reduce:active:scale-100"
      >
        <MessageCircleQuestion size={13} aria-hidden="true" />
        <span className="font-medium">BTW</span>
        <span className="tabular-nums text-(--color-text-subtle)">{btw.total}</span>
      </button>
    )
  }

  const count = exchanges.length
  const index = count === 0 ? -1 : view === null ? count - 1 : Math.min(Math.max(view, 0), count - 1)
  const current: BtwExchange | undefined = exchanges[index]
  const step = (delta: number) => {
    const next = index + delta
    if (next < 0 || next >= count) return
    store.setView(sessionId, next === count - 1 ? null : next)
  }
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
  const onStop = () => {
    if (!current) return
    if (current.live) void store.stop(sessionId)
    else if (current.id) void store.stopStored(sessionId, current.id)
  }

  return (
    <section
      aria-label="Side question"
      data-swipe-ignore
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          store.dismiss(sessionId)
        } else if (e.key === 'ArrowLeft' && e.shiftKey) {
          step(-1)
        } else if (e.key === 'ArrowRight' && e.shiftKey) {
          step(1)
        }
      }}
      className="pointer-events-auto mb-2 flex flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) text-xs shadow-(--shadow-depth)"
    >
      <header className="flex h-8 shrink-0 items-center gap-0.5 border-b border-(--color-border-subtle) pl-2.5 pr-1">
        <MessageCircleQuestion size={13} aria-hidden="true" className="mr-1 shrink-0 text-(--color-text-subtle)" />
        <span className="font-medium text-(--color-text)">Side question</span>
        <span className="ml-1.5 hidden truncate text-(--color-text-subtle) sm:inline">Not added to the chat</span>
        <span className="flex-1" />
        {count > 1 && (
          <>
            <Button size="icon-xs" variant="ghost" aria-label="Earlier side question" title="Earlier (Shift+←)" disabled={index <= 0} onClick={() => step(-1)}>
              <ChevronLeft />
            </Button>
            <span className="px-0.5 tabular-nums text-(--color-text-subtle)" aria-live="polite">
              {index + 1}/{count}
            </span>
            <Button size="icon-xs" variant="ghost" aria-label="Later side question" title="Later (Shift+→)" disabled={index >= count - 1} onClick={() => step(1)}>
              <ChevronRight />
            </Button>
          </>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Copy answer" title="Copy answer as Markdown" disabled={!current?.answer} onClick={() => current && copyText(current.answer)}>
          <Copy />
        </Button>
        <Button
          size={confirmClear ? 'xs' : 'icon-xs'}
          variant={confirmClear ? 'danger-subtle' : 'ghost'}
          aria-label={confirmClear ? 'Confirm: delete all side questions' : 'Clear side questions'}
          title={confirmClear ? undefined : 'Delete all side questions of this session'}
          disabled={count === 0}
          onClick={onClear}
        >
          <Trash2 />
          {confirmClear && <span>Clear all</span>}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close side question" title="Close (Esc)" onClick={() => store.dismiss(sessionId)}>
          <X />
        </Button>
      </header>
      <div className="max-h-[calc(var(--app-vh,100vh)*0.4)] min-h-0 overflow-y-auto overscroll-contain touch-pan-y px-3 py-2">
        {current ? (
          <ExchangeView exchange={current} sessionId={sessionId} />
        ) : btw.isLoading ? (
          <p className="text-(--color-text-subtle)">Loading side questions…</p>
        ) : (
          <p className="text-(--color-text-muted)">
            No side questions yet. Type <code className="font-mono">/btw</code> and a question to ask one without adding it to the chat.
          </p>
        )}
      </div>
      {current?.status === 'streaming' && (
        <footer className="flex shrink-0 justify-end border-t border-(--color-border-subtle) px-1.5 py-1">
          <Button size="xs" variant="ghost" onClick={onStop}>
            <Square className="size-3" />
            Stop
          </Button>
        </footer>
      )}
    </section>
  )
}

/** One side question and its answer (also the dock tab's rows). */
export function ExchangeView({ exchange, sessionId }: { exchange: BtwExchange; sessionId: string }) {
  const streaming = exchange.status === 'streaming'
  return (
    <div className="flex flex-col gap-1.5">
      <p className="whitespace-pre-wrap break-words text-(--color-text-muted)">{exchange.question}</p>
      {exchange.answer ? (
        <MarkdownBlock content={exchange.answer} sessionId={sessionId} isStreaming={streaming && exchange.live} />
      ) : streaming ? (
        <p className="animate-pulse text-(--color-text-subtle) motion-reduce:animate-none">Thinking…</p>
      ) : null}
      {exchange.status === 'error' && (
        <p role="alert" className="text-(--color-error)">{exchange.error || 'The side question failed.'}</p>
      )}
      {exchange.status === 'stopped' && <p className="text-(--color-text-subtle)">Stopped.</p>}
    </div>
  )
}
