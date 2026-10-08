import { memo, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ChevronUp, Paperclip, Pencil } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentStore } from '@/stores/useAgentStore'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'
import { useToastStore } from '@/stores/useToastStore'
import type { MessageAttachment } from '@/api/types'
import { cn } from '@/lib/utils'
import { designFeedbackPlainText } from '@/lib/design-feedback'
import { confirmedIdSet } from '@/utils/blocks'

const QUEUED_COLLAPSE_LINES = 10
const QUEUED_COLLAPSE_CHARS = 700
const NO_IDS: string[] = []

function QueuedAttachmentList({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((att, i) => (
        <span
          key={`${att.original_name ?? att.filename ?? 'file'}-${i}`}
          className="inline-flex max-w-full items-center gap-1 rounded-sm border border-(--color-border) bg-(--bg-key)/60 px-1.5 py-0.5 text-[11px] text-(--color-text-2)"
        >
          <Paperclip size={11} aria-hidden="true" className="shrink-0" />
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={<span className="truncate">{att.original_name ?? att.filename ?? 'attachment'}</span>}
            />
            <TooltipContent>{att.original_name ?? att.filename ?? 'attachment'}</TooltipContent>
          </Tooltip>
        </span>
      ))}
    </div>
  )
}

function QueuedMessageContent({ content: raw, attachments }: { content: string; attachments?: MessageAttachment[] }) {
  const [expanded, setExpanded] = useState(false)
  const content = designFeedbackPlainText(raw)
  const lines = content.split('\n')
  const needsCollapse = lines.length > QUEUED_COLLAPSE_LINES || content.length > QUEUED_COLLAPSE_CHARS
  const visibleContent = needsCollapse && !expanded
    ? lines.length > QUEUED_COLLAPSE_LINES
      ? lines.slice(0, QUEUED_COLLAPSE_LINES).join('\n')
      : `${content.slice(0, QUEUED_COLLAPSE_CHARS).trimEnd()}...`
    : content

  return (
    <div className="relative overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) px-4 py-3 text-sm leading-relaxed text-(--color-text) opacity-75">
      {needsCollapse && (
        <Tooltip className="absolute top-1.5 right-1.5 z-10">
          <TooltipTrigger
            render={
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-(--bg-key) text-(--color-text-2) transition-all duration-(--motion-fast) hover:text-(--color-text) active:scale-90 md:h-5 md:w-5"
              >
                {expanded ? <ChevronUp size={14} className="md:h-3 md:w-3" /> : <ChevronDown size={14} className="md:h-3 md:w-3" />}
              </button>
            }
          />
          <TooltipContent>{expanded ? 'Collapse' : 'Expand'}</TooltipContent>
        </Tooltip>
      )}
      <p className={cn('min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere]', needsCollapse && 'pr-12 md:pr-6')}>{visibleContent}</p>
      {attachments && attachments.length > 0 && <QueuedAttachmentList attachments={attachments} />}
      {needsCollapse && !expanded && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{
            height: '2.4rem',
            background: 'linear-gradient(to bottom, transparent 0%, var(--bg-card) 90%)',
          }}
        />
      )}
    </div>
  )
}

function QueuedBubble({ content, attachments, label, onEdit }: {
  content: string
  attachments?: MessageAttachment[]
  label: string
  onEdit: () => void | Promise<void>
}) {
  // A steer's edit waits for the server's cancel; a second click meanwhile
  // would cancel it twice.
  const [busy, setBusy] = useState(false)
  const edit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onEdit()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="group flex justify-end">
      <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[78%]">
        <div className="flex max-w-full items-start gap-2">
          <QueuedMessageContent content={content} attachments={attachments} />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  onClick={() => { void edit() }}
                  disabled={busy}
                  aria-label="Edit queued message"
                  className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-(--color-text-muted) opacity-100 transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-6 md:w-6 md:opacity-70 md:group-hover:opacity-100"
                >
                  <Pencil size={13} aria-hidden="true" className="md:h-3 md:w-3" />
                </button>
              }
            />
            <TooltipContent>Edit queued message</TooltipContent>
          </Tooltip>
        </div>
        <span className="pr-8 text-[11px] text-(--color-text-subtle)">{label}</span>
      </div>
    </div>
  )
}

/** Move a queued message back into the composer (see ``useSessionBootstrap``). */
function restoreDraft(content: string, files?: File[]) {
  // Files ride along because cancelling a server-queued message deletes its
  // persisted uploads. The event keeps this component free of the chat
  // view's composer ref.
  window.dispatchEvent(new CustomEvent('queue:restore-draft', { detail: { content, files } }))
}

export const PendingMessageQueue = memo(function PendingMessageQueue() {
  const allMessages = useAgentStore((s) => s._pendingMessages)
  const sessionId = useAgentStore((s) => s.sessionId)
  // `agentStreams` is replaced on every SSE flush, so select only which
  // queued ids a stream already shows: a token that changes nothing here must
  // not re-render the queue (or re-scan the session) on a phone WebView. By
  // id only: a queued message always has its server id, and matching text
  // hid any steer the session had already sent once ("continue").
  const shownIds = useAgentStore(
    useShallow((s) => {
      if (s._pendingMessages.length === 0) return NO_IDS
      const streams = Object.values(s.agentStreams)
      return s._pendingMessages
        .filter((msg) => streams.some((st) => confirmedIdSet(st.blocks).has(msg.id) || st.currentBlocks.some((b) => b.id === msg.id)))
        .map((msg) => msg.id)
    }),
  )

  const messages = useMemo(
    () =>
      allMessages.filter((msg) => {
        if (msg.sessionId && sessionId && msg.sessionId !== sessionId) return false
        return !shownIds.includes(msg.id)
      }),
    [allMessages, sessionId, shownIds],
  )
  const removePendingMessage = useAgentStore((s) => s.removePendingMessage)
  // A steer still queued after a failed turn (its files are on another
  // device, so it was not handed back) has no running turn to read it.
  const turnFailed = useAgentStore((s) => (
    !s.isAgentWorking && Boolean(s.leadName) && s.agentStreams?.[s.leadName as string]?.status === 'error'
  ))
  const allHeld = useHeldMessagesStore((s) => s.messages)
  const held = useMemo(() => allHeld.filter((msg) => msg.sessionId === sessionId), [allHeld, sessionId])

  if (messages.length === 0 && held.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {messages.map((msg) => (
        <QueuedBubble
          key={msg.id}
          content={msg.content}
          attachments={msg.attachments}
          // The backend hands it to the agent before its next model call, or
          // ahead of the next message once the turn has failed.
          label={`${msg.sentFromWorkspace ? `From ${msg.sentFromWorkspace} · ` : ''}${turnFailed ? 'Sends with your next message' : 'Read before the next step'}`}
          onEdit={async () => {
            const outcome = await removePendingMessage(msg.id)
            if (outcome === 'cancelled') restoreDraft(msg.content, msg.files)
            else if (outcome === 'sent') {
              useToastStore.getState().push({
                tone: 'info',
                title: 'Already sent to the agent',
                description: 'It reached the agent before it could be edited.',
              })
            }
          }}
        />
      ))}
      {held.map((msg) => (
        <QueuedBubble
          key={msg.id}
          content={msg.content}
          attachments={msg.attachments}
          label="Sends when this turn ends"
          onEdit={() => {
            // Held client-side only, so there is nothing to cancel on the server.
            if (useHeldMessagesStore.getState().take(msg.id)) restoreDraft(msg.content, msg.files)
          }}
        />
      ))}
    </div>
  )
})
