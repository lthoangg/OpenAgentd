import { useEffect, useMemo, useState, memo } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, Undo2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { FileLightbox, type FileLightboxItem, type FileLightboxItemType } from '../FileLightbox'
import { FileTypeIcon } from '../FileTypeIcon'
import { findCommittedMentions } from '../InputComposer.mentions'
import { resolveApiUrl } from '@/api/client'
import { openExternalUrl } from '@/lib/open-external'
import { formatTime, formatFullDateTime } from '@/utils/format'
import type { MessageAttachment } from '@/api/types'
import { cn } from '@/lib/utils'

/** Matches http:// and https:// URLs (greedy, stops at whitespace or common trailing punctuation). */
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

/** Split a plain string into text and URL segments and render URLs as links. */
function renderUrlSegments(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const url = match[0]
    out.push(
      <a
        key={`${keyPrefix}-${match.index}`}
        href={url}
        onClick={(e) => { e.preventDefault(); void openExternalUrl(url) }}
        className="text-(--accent-blue-text) font-medium underline [text-decoration-color:var(--color-border-strong)] [text-decoration-thickness:1px] underline-offset-[3px] transition-colors duration-[120ms] hover:text-(--accent-blue) hover:[text-decoration-color:currentColor] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) rounded-sm break-all"
        rel="noopener noreferrer"
      >
        {url}
      </a>
    )
    last = match.index + url.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const USER_COLLAPSE_LINES = 10
const USER_COLLAPSE_CHARS = 700

function shortModelName(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return modelId.split(':').at(-1)?.split('/').at(-1) || modelId
}

/**
 * Render user prose with ``@mention`` tokens syntax-highlighted.
 *
 * Matches the InputComposer's overlay convention so a message looks the same
 * after send as it did while composing:
 *   - folders (token ends in ``/``)      → ``--accent-orange-text``
 *   - files (everything else, default)   → ``--accent-blue-text``
 *
 * The slash heuristic is what the picker inserts; using it (rather than
 * resolving against ``fileRefs``) keeps highlighting stable for old
 * messages whose referenced paths may since have been renamed/removed.
 * ``findCommittedMentions`` without refs falls back to syntax-only range
 * detection — same code path the overlay relies on.
 */
function renderMentionSegments(content: string, onMentionFileOpen?: (path: string) => void, mentions?: string[]): React.ReactNode[] {
  const ranges = findCommittedMentions(content, null, undefined, mentions)
  if (ranges.length === 0) return renderUrlSegments(content, 'url')
  const out: React.ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push(...renderUrlSegments(content.slice(cursor, r.start), `pre-${cursor}`))
    const token = content.slice(r.start, r.end)
    const isFolder = token.endsWith('/')
    const path = token.slice(1)
    out.push(onMentionFileOpen && !isFolder ? (
      <button
        key={r.start}
        type="button"
        data-mention-kind="file"
        onClick={() => onMentionFileOpen(path)}
        className="inline rounded-sm text-(--accent-blue-text) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
      >
        {token}
      </button>
    ) : (
      <span
        key={r.start}
        data-mention-kind={isFolder ? 'directory' : 'file'}
        className={
          isFolder ? 'text-(--accent-orange-text)' : 'text-(--accent-blue-text)'
        }
      >
        {token}
      </span>
    ))
    cursor = r.end
  }
  if (cursor < content.length) out.push(...renderUrlSegments(content.slice(cursor), `post-${cursor}`))
  return out
}

// ── AttachmentStrip ───────────────────────────────────────────────────────────

function attItemType(att: MessageAttachment): FileLightboxItemType {
  const mime = att.media_type ?? ''
  if (att.category === 'image' || mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (att.category === 'text' || mime.startsWith('text/')) return 'text'
  return 'file'
}

function AttachmentStrip({ attachments }: { attachments: MessageAttachment[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const items: FileLightboxItem[] = useMemo(
    () => attachments.map((att, i) => ({
      type: attItemType(att),
      src: resolveApiUrl(att.url) || att.url || '',
      name: att.filename || att.original_name || `Attachment ${i + 1}`,
    })),
    [attachments],
  )

  // Reset lightbox if attachments shrink (e.g. optimistic update rollback)
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= items.length) {
      setLightboxIndex(null)
    }
  }, [items.length, lightboxIndex])

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {items.map((item, idx) => (
          <AttachmentThumb
            key={item.src || idx}
            item={item}
            onOpen={() => setLightboxIndex(idx)}
          />
        ))}
      </div>

      <FileLightbox
        items={items}
        index={lightboxIndex ?? 0}
        isOpen={lightboxIndex !== null}
        onClose={() => setLightboxIndex(null)}
      />
    </>
  )
}

function AttachmentThumb({ item, onOpen }: { item: FileLightboxItem; onOpen: () => void }) {
  const [imgError, setImgError] = useState(false)

  if (item.type === 'image') {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="overflow-hidden rounded-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
        aria-label={`Preview ${item.name}`}
      >
        {imgError
          ? <div className="flex h-[120px] w-[120px] items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-xs text-(--color-text-muted)">Failed to load</div>
          : <img src={item.src} alt={item.name} loading="lazy" onError={() => setImgError(true)} className="max-h-[200px] max-w-[200px] rounded-sm object-cover" />
        }
      </button>
    )
  }

  // All non-image types: icon chip that opens the lightbox
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className="flex items-center gap-2 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 py-1.5 text-xs text-(--color-text) transition-colors hover:border-(--color-border-strong) hover:bg-(--bg-key)/40 focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
          >
            <span className="shrink-0 text-(--color-text-muted)">
              <FileTypeIcon name={item.name} size={14} />
            </span>
            <span className="max-w-[160px] truncate font-medium">{item.name}</span>
          </button>
        }
      />
      <TooltipContent>{item.name}</TooltipContent>
    </Tooltip>
  )
}

export const UserBubble = memo(function UserBubble({ content, timestamp, attachments, onRevert, modelId, onMentionFileOpen, mentions }: { content: string; timestamp?: Date; attachments?: MessageAttachment[]; onRevert?: () => void; modelId?: string | null; onMentionFileOpen?: (path: string) => void; mentions?: string[] }) {
  const [showTime, setShowTime] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const modelName = shortModelName(modelId)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const lines = content.split('\n')
  const needsCollapse = lines.length > USER_COLLAPSE_LINES || content.length > USER_COLLAPSE_CHARS
  const visibleContent = needsCollapse && !expanded
    ? lines.length > USER_COLLAPSE_LINES
      ? lines.slice(0, USER_COLLAPSE_LINES).join('\n')
      : `${content.slice(0, USER_COLLAPSE_CHARS).trimEnd()}...`
    : content
  const visibleAttachments = attachments?.filter((att) => att.source !== 'mention') ?? []

  return (
    <div
      className="group mb-3 flex justify-end"
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
    >
      <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[78%]">
         {/* Attachments */}
         {visibleAttachments.length > 0 && (
           <AttachmentStrip attachments={visibleAttachments} />
         )}

          <div className="relative min-w-0 max-w-full overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2.5 text-sm leading-relaxed text-(--color-text) shadow-sm selectable-text">
           {/* Expand / collapse button — top-right inside bubble */}
           {needsCollapse && (
             <Tooltip className="absolute top-1.5 right-1.5 z-10">
               <TooltipTrigger
                 render={
                   <button
                     onClick={() => setExpanded((v) => !v)}
                     aria-expanded={expanded}
                     aria-label={expanded ? 'Collapse' : 'Expand'}
                     className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-(--bg-key) text-(--color-text-2) transition-all duration-150 hover:text-(--color-text) active:scale-90"
                   >
                     {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                   </button>
                 }
               />
               <TooltipContent>{expanded ? 'Collapse' : 'Expand'}</TooltipContent>
             </Tooltip>
           )}
           <p className={cn('min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere]', needsCollapse && 'pr-6')}>{renderMentionSegments(visibleContent, onMentionFileOpen, mentions)}</p>
           {/* Gradient fade at bottom when collapsed */}
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

         {/* Copy button + timestamp row */}
          {(timestamp || modelName) && (
            <div className={`flex items-center gap-1.5 transition-opacity duration-150 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
              {modelName && (
                <span className="mr-1 font-mono text-[11px] text-(--color-text-subtle)">{modelName}</span>
              )}
               {onRevert && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        onClick={onRevert}
                        className="rounded-xs p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 active:scale-90"
                        aria-label="Revert latest message"
                      >
                        <Undo2 size={11} />
                      </button>
                    }
                  />
                  <TooltipContent>Revert latest message</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      onClick={handleCopy}
                      className="rounded-xs p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 active:scale-90"
                      aria-label="Copy message"
                    >
                      {copied ? (
                        <Check size={11} className="text-(--color-success)" />
                      ) : (
                        <Copy size={11} />
                      )}
                    </button>
                  }
                />
                <TooltipContent>Copy</TooltipContent>
              </Tooltip>
              {timestamp && (
                <Tooltip className="text-xs text-(--color-text-subtle)">
                  <TooltipTrigger
                    render={
                      <span className="text-xs text-(--color-text-subtle)" aria-hidden={!showTime}>
                        {formatTime(timestamp)}
                      </span>
                    }
                  />
                  <TooltipContent>{formatFullDateTime(timestamp)}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
      </div>
    </div>
  )
})
