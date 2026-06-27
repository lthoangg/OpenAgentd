import { useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useTeamStore } from '@/stores/useTeamStore'

const QUEUED_COLLAPSE_LINES = 10
const QUEUED_COLLAPSE_CHARS = 700

function QueuedMessageContent({ content }: { content: string }) {
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

  const handleRemove = (id: string, content: string) => {
    // Move the queued text back into the composer so the user can edit
    // or resend it instead of losing what they typed. Mirrors the
    // restore-on-/undo flow in TeamChatView. The CustomEvent matches
    // the existing `focus-chat-input` pattern and decouples this
    // component from the chat view's inputRef.
    window.dispatchEvent(
      new CustomEvent('queue:restore-draft', { detail: { content } }),
    )
    removePendingMessage(id)
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((msg) => (
        <div key={msg.id} className="group flex justify-end">
          <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[78%]">
            <div className="flex max-w-full items-start gap-2">
              <QueuedMessageContent content={msg.content} />
              <button
                onClick={() => handleRemove(msg.id, msg.content)}
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
