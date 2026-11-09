import { memo, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUpRight, ChevronDown, ChevronUp, Paperclip, Pencil } from 'lucide-react'
import { useIsPhone } from '@/hooks/use-is-phone'
import { Button } from '@/components/ui/button'
import { CloseButton } from '@/components/ui/close-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import type { MessageAttachment } from '@/api/types'
import { cn } from '@/lib/utils'
import { designFeedbackPlainText } from '@/lib/design-feedback'
import { confirmedIdSet } from '@/utils/blocks'
import { requestOpenSession } from '@/utils/workspace-messages'

const QUEUED_COLLAPSE_LINES = 10
const QUEUED_COLLAPSE_CHARS = 700
const NO_IDS: string[] = []

function QueuedAttachmentList({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((att, i) => (
        <span
          key={`${att.original_name ?? att.filename ?? 'file'}-${i}`}
          className="inline-flex max-w-full items-center gap-1 rounded-xs bg-(--bg-key) px-1.5 py-0.5 text-meta text-(--color-text-2)"
        >
          <Paperclip size={12} aria-hidden="true" className="shrink-0" />
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
      : `${content.slice(0, QUEUED_COLLAPSE_CHARS).trimEnd()}…`
    : content

  return (
    <div className="relative overflow-hidden rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-4 py-3 text-sm leading-relaxed text-(--color-text) opacity-75">
      {needsCollapse && (
        <Tooltip className="absolute top-1.5 right-1.5 z-10">
          <TooltipTrigger
            render={
              <Button
                variant="subtle"
                size="icon-xs"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? 'Collapse' : 'Expand'}
              >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </Button>
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

/** Another workspace's agent that sent a queued message, and its session. */
interface QueuedSender {
  workspaceName: string
  sessionId: string
  workspace: string
}

/** "From <workspace> ↗" opens the sender, as the chip on a delivered prompt does. */
function QueuedSenderChip({ sender }: { sender: QueuedSender }) {
  return (
    <button
      type="button"
      onClick={() => requestOpenSession({ sessionId: sender.sessionId, workspace: sender.workspace })}
      className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-xs px-1.5 text-meta text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-9"
      title={`Sent by the agent in ${sender.workspace || sender.workspaceName}`}
      aria-label={`Open the sending session in ${sender.workspaceName}`}
      data-sent-from
    >
      <span className="shrink-0">From</span>
      <span className="min-w-0 truncate font-mono font-semibold text-(--color-text)">{sender.workspaceName}</span>
      <ArrowUpRight size={12} aria-hidden="true" className="shrink-0" />
    </button>
  )
}

function QueuedBubble({ content, attachments, label, sender, onEdit, onRemove }: {
  content: string
  attachments?: MessageAttachment[]
  /** Delivery state ("Read before the next step"); the sender, when known, is a chip before it. */
  label: string
  sender?: QueuedSender
  onEdit: () => void | Promise<void>
  /** Throws the message away; the queue offers Undo, which is why it asks nothing first. */
  onRemove: () => void | Promise<void>
}) {
  // A steer's edit or removal waits for the server's cancel; a second click
  // meanwhile would cancel it twice.
  const [busy, setBusy] = useState(false)
  const run = async (action: () => void | Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  return (
    // Queued from the composer: it rises into place like a sent prompt.
    <div className="oa-rise-in flex justify-end">
      <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[78%]">
        <div className="flex max-w-full items-start gap-2">
          <QueuedMessageContent content={content} attachments={attachments} />
          <div className="mt-1 flex shrink-0 flex-col gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => { void run(onEdit) }}
                    disabled={busy}
                    aria-label="Edit queued message"
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipContent>Edit queued message</TooltipContent>
            </Tooltip>
            {/* The × removes the message rather than closing anything, so it says so. */}
            <CloseButton
              size="icon-xs"
              label="Remove queued message"
              tooltip="Remove queued message"
              onClick={() => { void run(onRemove) }}
              disabled={busy}
            />
          </div>
        </div>
        {sender ? (
          <span className="flex max-w-full flex-wrap items-center justify-end pr-6 text-meta text-(--color-text-subtle)">
            <QueuedSenderChip sender={sender} />
            <span>· {label}</span>
          </span>
        ) : (
          <span className="pr-8 text-meta text-(--color-text-subtle)">{label}</span>
        )}
      </div>
    </div>
  )
}

/**
 * A phone's queued message: a faded bubble at the end of the transcript,
 * where it will land (user request: below the chat, not above the composer).
 * Its one action is a tap, which takes it back into the composer: to edit,
 * or to clear from there (user request: no ✕, nothing to undo). Long text
 * shows four lines.
 */
function QueuedPhoneBubble({ content, label, onEdit }: {
  content: string
  attachments?: MessageAttachment[]
  label: string
  sender?: QueuedSender
  onEdit: () => void | Promise<void>
  onRemove: () => void | Promise<void>
}) {
  // A steer waits for the server's cancel; a second tap would cancel it twice.
  const [busy, setBusy] = useState(false)
  const text = designFeedbackPlainText(content).trim()
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
    <div data-queued-bubble="" className="oa-rise-in flex flex-col items-end gap-1 opacity-60">
      <button
        type="button"
        aria-label={`Edit queued message: ${text.replace(/\s+/g, ' ')}`}
        onClick={() => { void edit() }}
        disabled={busy}
        className="min-w-0 max-w-[85%] rounded-sm bg-(--bg-key) px-3 py-2.5 text-left text-sm leading-relaxed text-(--color-text) transition-transform duration-(--motion-instant) active:scale-[0.98] motion-reduce:active:scale-100"
      >
        <span className="line-clamp-4 break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
      </button>
      <span className="text-meta text-(--color-text-muted)">{label} · Tap to edit</span>
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

/** Told after a removal, so a slip of the finger costs nothing: Undo puts the text back in the composer. */
function offerUndo(content: string, files?: File[]) {
  useToastStore.getState().push({
    tone: 'info',
    title: 'Queued message removed',
    description: 'It will not be sent.',
    action: { label: 'Undo', onAction: () => restoreDraft(content, files) },
  })
}

/**
 * Queued messages at the end of the transcript, under the turn they wait
 * behind: bubbles with Edit and Remove on desktop, faded bubbles on a phone.
 */
export const PendingMessageQueue = memo(function PendingMessageQueue() {
  const isPhone = useIsPhone()
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

  if (messages.length === 0) return null
  const Item = isPhone ? QueuedPhoneBubble : QueuedBubble

  return (
    <div className={isPhone ? 'flex flex-col gap-2.5' : 'flex flex-col gap-3'}>
      {messages.map((msg) => (
        <Item
          key={msg.id}
          content={msg.content}
          attachments={msg.attachments}
          // The backend hands it to the agent before its next model call, or
          // ahead of the next message once the turn has failed.
          label={`${msg.sentFromWorkspace && !msg.sentFromSession ? `From ${msg.sentFromWorkspace} · ` : ''}${turnFailed ? 'Sends with your next message' : msg.heldUntilTurnEnd ? 'Sends when this turn ends' : 'Read before the next step'}`}
          sender={msg.sentFromWorkspace && msg.sentFromSession ? { workspaceName: msg.sentFromWorkspace, ...msg.sentFromSession } : undefined}
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
          onRemove={async () => {
            const outcome = await removePendingMessage(msg.id)
            if (outcome === 'cancelled') offerUndo(msg.content, msg.files)
            else if (outcome === 'sent') {
              useToastStore.getState().push({
                tone: 'info',
                title: 'Already sent to the agent',
                description: 'It reached the agent before it could be removed.',
              })
            }
          }}
        />
      ))}
    </div>
  )
})
