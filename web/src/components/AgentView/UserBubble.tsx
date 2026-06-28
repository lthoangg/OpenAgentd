import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, Terminal, Undo2 } from 'lucide-react'

import { ImageAttachment } from '../ImageAttachment'
import { FileCard } from '../FileCard'
import { findCommittedMentions } from '../InputBar.mentions'
import { resolveApiUrl } from '@/api/client'
import { openExternalUrl } from '@/lib/open-external'
import { formatTime } from '@/utils/format'
import type { MessageAttachment } from '@/api/types'

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
        className="font-medium underline [text-decoration-color:var(--color-border-strong)] [text-decoration-thickness:1px] underline-offset-[3px] transition-colors duration-[120ms] hover:text-(--color-accent) hover:[text-decoration-color:currentColor] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) rounded-sm"
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
 * Matches the InputBar's overlay convention so a message looks the same
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
function renderMentionSegments(content: string, onMentionFileOpen?: (path: string) => void): React.ReactNode[] {
  const ranges = findCommittedMentions(content, null)
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

export function UserBubble({ content, timestamp, attachments, onRevert, modelId, shell, onMentionFileOpen }: { content: string; timestamp?: Date; attachments?: MessageAttachment[]; onRevert?: () => void; modelId?: string | null; shell?: boolean; onMentionFileOpen?: (path: string) => void }) {
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
           <div className="flex flex-wrap justify-end gap-2">
             {(() => {
               // Build a gallery of all image attachments so the lightbox can
               // swipe between siblings, and map each thumbnail to its index.
               const imageGallery = visibleAttachments
                 .filter((a: MessageAttachment) => a.category === 'image')
                 .map((a: MessageAttachment, i: number) => ({
                   src: resolveApiUrl(a.url) || '',
                   alt: a.original_name || `Attachment ${i + 1}`,
                 }))
               let imageCursor = -1
               return visibleAttachments.map((att: MessageAttachment, idx: number) => {
               const isImage = att.category === 'image'

               if (isImage) {
                 imageCursor += 1
                 return (
                   <ImageAttachment
                     key={idx}
                     src={resolveApiUrl(att.url) || ''}
                     alt={att.original_name || `Attachment ${idx + 1}`}
                     gallery={imageGallery}
                     galleryIndex={imageCursor}
                   />
                 )
               }

               return (
                 <FileCard
                   key={idx}
                   name={att.original_name || att.filename || `File ${idx + 1}`}
                   mediaType={att.media_type}
                   url={resolveApiUrl(att.url)}
                   clickable={!!att.url}
                 />
               )
             })
             })()}
           </div>
         )}

          <div className={`relative min-w-0 max-w-full overflow-hidden rounded-sm border px-3 py-2.5 text-sm leading-relaxed text-(--color-text) shadow-sm selectable-text ${shell ? 'border-(--accent-blue)/30 bg-(--bg-key)' : 'border-(--color-border) bg-(--bg-card)'}`}>
           {/* Expand / collapse button — top-right inside bubble */}
           {needsCollapse && (
             <button
               onClick={() => setExpanded((v) => !v)}
               aria-expanded={expanded}
               title={expanded ? 'Collapse' : 'Expand'}
               className="absolute top-1.5 right-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-(--bg-key) text-(--color-text-2) transition-all duration-150 hover:text-(--color-text) active:scale-90"
             >
               {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
             </button>
           )}
           {shell && (
             <div className="mb-1.5 flex items-center gap-1 font-mono text-[11px] text-(--color-text-muted)">
               <Terminal size={12} aria-hidden="true" />
               <span>Shell</span>
             </div>
           )}
           <p className={`min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere] ${shell ? 'font-mono' : ''}`}>{renderMentionSegments(visibleContent, onMentionFileOpen)}</p>
           {/* Gradient fade at bottom when collapsed */}
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

         {/* Copy button + timestamp row */}
          {(timestamp || modelName) && (
            <div className={`flex items-center gap-1.5 transition-opacity duration-150 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
              {modelName && (
                <span className="mr-1 font-mono text-[11px] text-(--color-text-subtle)" title={modelId ?? undefined}>
                  {modelName}
                </span>
              )}
               {onRevert && (
                <button
                  onClick={onRevert}
                  className="rounded-xs p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                  aria-label="Revert latest message"
                  title="Revert latest message"
                >
                  <Undo2 size={11} />
                </button>
              )}
              <button
                onClick={handleCopy}
                className="rounded-xs p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
               aria-label="Copy message"
               title="Copy"
             >
               {copied ? (
                 <Check size={11} className="text-(--color-success)" />
               ) : (
                 <Copy size={11} />
               )}
             </button>
              {timestamp && (
                <span
                  className="text-xs text-(--color-text-subtle)"
                  aria-hidden={!showTime}
                  title={formatTime(timestamp)}
                >
                  {formatTime(timestamp)}
                </span>
              )}
            </div>
          )}
      </div>
    </div>
  )
}
