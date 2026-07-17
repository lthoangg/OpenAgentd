import { useState } from 'react'
import { ChevronDown, ChevronUp, Paperclip, X } from 'lucide-react'
import { useTeamStore } from '@/stores/useTeamStore'
import type { MessageAttachment } from '@/api/types'

const QUEUED_COLLAPSE_LINES = 10
const QUEUED_COLLAPSE_CHARS = 700

function QueuedAttachmentList({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((att, i) => (
        <span
          key={`${att.original_name ?? att.filename ?? 'file'}-${i}`}
          className="inline-flex max-w-full items-center gap-1 rounded-sm border border-(--color-border) bg-(--bg-key)/60 px-1.5 py-0.5 text-[11px] text-(--color-text-2)"
        >
          <Paperclip size={11} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{att.original_name ?? att.filename ?? 'attachment'}</span>
        </span>
      ))}
    </div>
  )
}

function QueuedMessageContent({ content, attachments }: { content: string; attachments?: MessageAttachment[] }) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const needsCollapse = lines.length > QUEUED_COLLAPSE_LINES || content.length > QUEUED_COLLAPSE_CHARS
  const visibleContent = needsCollapse && !expanded
    ? lines.length > QUEUED_COLLAPSE_LINES
      ? lines.slice(0, QUEUED_COLLAPSE_LINES).join('\n')
      : `${content.slice(0, QUEUED_COLLAPSE_CHARS).trimEnd()}...`
    : content

  return (
    <div className="relative overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) px-4 py-3 text-sm leading-relaxed text-(--color-text) opacity-75 shadow-sm">
      {needsCollapse && (
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Collapse' : 'Expand'}
          className="absolute top-1.5 right-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-2) transition-all duration-150 hover:text-(--color-text) active:scale-90 md:h-5 md:w-5"
        >
          {expanded ? <ChevronUp size={14} className="md:h-3 md:w-3" /> : <ChevronDown size={14} className="md:h-3 md:w-3" />}
        </button>
      )}
      <p className="min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{visibleContent}</p>
      {attachments && attachments.length > 0 && <QueuedAttachmentList attachments={attachments} />}
      {needsCollapse && !expanded && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 backdrop-blur-[1px]"
          style={{
            height: '2.4rem',
            background: 'linear-gradient(to bottom, transparent 0%, var(--bg-card) 90%)',
          }}
        />
      )}
    </div>
  )
}

export function PendingMessageQueue() {
  const allMessages = useTeamStore((s) => s._pendingMessages)
  const sessionId = useTeamStore((s) => s.sessionId)
  const messages = allMessages.filter((msg) => (msg.sessionId ?? null) === sessionId)
  const removePendingMessage = useTeamStore((s) => s.removePendingMessage)

  if (messages.length === 0) return null

  const handleRemove = (id: string, content: string, files?: File[]) => {
    // Move the queued text (and any queued files) back into the composer so
    // the user can edit or resend instead of losing what they typed. Files
    // must ride along because cancelling deletes the persisted uploads
    // server-side. Mirrors the restore-on-/undo flow in TeamChatView. The
    // CustomEvent matches the existing `focus-chat-input` pattern and
    // decouples this component from the chat view's inputRef.
    window.dispatchEvent(
      new CustomEvent('queue:restore-draft', { detail: { content, files } }),
    )
    removePendingMessage(id)
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((msg) => (
        <div key={msg.id} className="group flex justify-end">
          <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[78%]">
            <div className="flex max-w-full items-start gap-2">
              <QueuedMessageContent content={msg.content} attachments={msg.attachments} />
              <button
                onClick={() => handleRemove(msg.id, msg.content, msg.files)}
                aria-label="Edit queued message"
                title="Edit queued message"
                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-(--color-text-muted) opacity-100 transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-6 md:w-6 md:opacity-70 md:group-hover:opacity-100"
              >
                <X size={14} className="md:h-[13px] md:w-[13px]" />
              </button>
            </div>
            <span className="pr-8 text-[11px] text-(--color-text-subtle)">Queued</span>
          </div>
        </div>
      ))}
    </div>
  )
}
