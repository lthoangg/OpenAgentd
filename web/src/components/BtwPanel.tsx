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
 *
 * Clear asks first, through the shared ConfirmDialog: deleting every side
 * question of the session cannot be undone. The chip is always "Side
 * questions" (one name; it truncates when space is short).
 */
import { useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, MessageCircleQuestion, Square, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/components/ChatContextMenu'
import { useSideQuestions, type BtwExchange } from '@/queries/useSideQuestionsQuery'
import { useBtwStore } from '@/stores/useBtwStore'
import { useToastStore } from '@/stores/useToastStore'
import { MarkdownBlock } from '@/utils/markdown'

interface BtwPanelProps {
  sessionId: string | null
  /** Fetch the stored count for the reopen chip (the session has messages). */
  countEnabled: boolean
  /** Never show the panel, only the chip (the dock shows side questions). */
  chipOnly?: boolean
  /** What the chip does; defaults to reopening this panel. */
  onReopen?: () => void
}

/** An icon action with its name in a tooltip. */
function HeaderAction({ label, tooltip, children, ...props }: {
  label: string
  tooltip: string
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label} {...props}>
            {children}
          </Button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export function BtwPanel({ sessionId, countEnabled, chipOnly = false, onReopen }: BtwPanelProps) {
  const btw = useSideQuestions(sessionId, { countEnabled, listEnabled: chipOnly ? false : undefined })
  const [confirmClear, setConfirmClear] = useState(false)
  const { exchanges, view } = btw
  const open = btw.open && !chipOnly

  if (!sessionId) return null
  const store = useBtwStore.getState()

  if (!open) {
    if (btw.total <= 0) return null
    return (
      <div className="pointer-events-auto absolute bottom-full right-3 z-10 mb-3 flex max-w-[calc(100%-1.5rem)] origin-bottom-right animate-in fade-in-0 zoom-in-95 animation-duration-(--motion-base) ease-(--ease-out)">
        <Tooltip className="min-w-0">
          <TooltipTrigger
            className="min-w-0"
            render={
              <button
                type="button"
                onClick={() => (onReopen ? onReopen() : store.reopen(sessionId))}
                aria-label={`Show side questions (${btw.total})`}
                // Floats over the transcript like the jump-to-latest chip, so the
                // composer never moves for it.
                className="flex h-7 min-w-0 items-center gap-1 rounded-full bg-(--bg-key) px-2 text-xs text-(--color-text-2) shadow-(--shadow-depth) transition-colors duration-(--motion-instant) hover:bg-(--color-fill-key-hover) hover:text-(--color-text) active:scale-95 motion-reduce:active:scale-100 pointer-coarse:h-9 pointer-coarse:px-3"
              >
                <MessageCircleQuestion size={13} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 truncate font-medium">Side questions</span>
                <span className="shrink-0 tabular-nums text-(--color-text-muted)">{btw.total}</span>
              </button>
            }
          />
          <TooltipContent>Side questions (/btw)</TooltipContent>
        </Tooltip>
      </div>
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
    // Failures surface as a toast; the dialog closes either way.
    return store.clear(sessionId).catch((err: unknown) => {
      useToastStore.getState().push({ tone: 'error', title: 'Could not clear side questions', description: err instanceof Error ? err.message : String(err) })
    })
  }
  const onStop = () => {
    if (!current) return
    if (current.live) void store.stop(sessionId)
    else if (current.id) void store.stopStored(sessionId, current.id)
  }

  return (
    <>
    <section
      aria-label="Side questions"
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
      // Rises out of the composer it sits on (DESIGN.md → Motion: ``base``).
      className="pointer-events-auto mb-2 flex flex-col overflow-hidden rounded-sm border border-(--color-border-subtle) bg-(--bg-card) text-xs shadow-(--shadow-depth) animate-in fade-in-0 slide-in-from-bottom-1 animation-duration-(--motion-base) ease-(--ease-out)"
    >
      <header className="flex h-8 shrink-0 items-center gap-0.5 pl-2.5 pr-1">
        <span className="font-medium text-(--color-text)">Side questions</span>
        <span className="ml-1.5 hidden truncate text-(--color-text-muted) sm:inline">Not added to the chat</span>
        <span className="flex-1" />
        {count > 1 && (
          <>
            <HeaderAction label="Earlier side question" tooltip="Earlier (Shift+←)" disabled={index <= 0} onClick={() => step(-1)}>
              <ChevronLeft />
            </HeaderAction>
            <span className="px-0.5 tabular-nums text-(--color-text-muted)" aria-live="polite">
              {index + 1}/{count}
            </span>
            <HeaderAction label="Later side question" tooltip="Later (Shift+→)" disabled={index >= count - 1} onClick={() => step(1)}>
              <ChevronRight />
            </HeaderAction>
          </>
        )}
        <HeaderAction label="Copy answer" tooltip="Copy answer as Markdown" disabled={!current?.answer} onClick={() => current && copyText(current.answer)}>
          <Copy />
        </HeaderAction>
        <HeaderAction label="Clear side questions" tooltip={count === 0 ? 'No side questions yet' : 'Delete all side questions of this session'} disabled={count === 0} onClick={() => setConfirmClear(true)}>
          <Trash2 />
        </HeaderAction>
        <HeaderAction label="Close side questions" tooltip="Close (Esc)" onClick={() => store.dismiss(sessionId)}>
          <X />
        </HeaderAction>
      </header>
      <div className="max-h-[calc(var(--app-vh,100vh)*0.4)] min-h-0 overflow-y-auto overscroll-contain touch-pan-y px-3 py-2">
        {current ? (
          <ExchangeView exchange={current} sessionId={sessionId} />
        ) : btw.isLoading ? (
          <p className="text-(--color-text-muted)">Loading side questions…</p>
        ) : (
          <p className="text-(--color-text-muted)">
            No side questions yet. Type <code className="font-mono">/btw</code> and a question to ask one without adding it to the chat.
          </p>
        )}
      </div>
      {current?.status === 'streaming' && (
        <footer className="flex shrink-0 justify-end px-1.5 py-1">
          <Button size="xs" variant="ghost" onClick={onStop}>
            <Square className="size-3" />
            Stop
          </Button>
        </footer>
      )}
    </section>
    <ConfirmDialog
      open={confirmClear}
      onOpenChange={setConfirmClear}
      title="Delete all side questions?"
      description="Every side question and answer of this session is deleted. They were never part of the chat, and this cannot be undone."
      confirmLabel="Delete all"
      onConfirm={onClear}
    />
    </>
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
        <p role="status"><span className="oa-shimmer">Thinking…</span></p>
      ) : null}
      {exchange.status === 'error' && (
        <p role="alert" className="text-(--color-error)">{exchange.error || 'The side question failed.'}</p>
      )}
      {exchange.status === 'stopped' && <p className="text-(--color-text-muted)">Stopped.</p>}
    </div>
  )
}
