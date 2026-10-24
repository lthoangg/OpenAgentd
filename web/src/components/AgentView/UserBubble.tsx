import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import { ArrowUpRight, Check, ChevronDown, ChevronUp, Copy, Pencil } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GoalSetBadge } from '@/components/GoalSetBadge'
import { MarkdownBlock } from '@/utils/markdown'

import { FileLightbox, type FileLightboxItem, type FileLightboxItemType } from '../FileLightbox'
import { FileTypeIcon } from '../FileTypeIcon'
import { FileRefContext } from '../FileRefLink'
import { findCommittedMentions } from '../InputComposer.mentions'
import { DesignFeedbackCard } from '../DesignFeedbackViews'
import { splitDesignFeedback } from '@/lib/design-feedback'
import { resolveApiUrl } from '@/api/client'
import { openExternalUrl } from '@/lib/open-external'
import { copyText, useChatMenu } from '../ChatContextMenu'
import { formatTime, formatFullDateTime, shortModelName } from '@/utils/format'
import type { MessageAttachment } from '@/api/types'
import { cn } from '@/lib/utils'
import { useImageBox } from '@/lib/image-size'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { replyLabel, type ReplyFrom, type SentFrom } from '@/utils/workspace-messages'

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
        className="text-(--accent-blue-text) font-medium underline [text-decoration-color:var(--color-border-strong)] [text-decoration-thickness:1px] underline-offset-[3px] transition-colors duration-(--motion-instant) hover:text-(--accent-blue) hover:[text-decoration-color:currentColor] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) rounded-sm break-all"
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

/**
 * Long prompts fold to their first lines. Lines are the ones on screen, not
 * newlines: the same prompt wraps to more lines when the chat is narrow (the
 * sidebar or the dock open), so the bubble measures itself and re-checks on
 * every width change. A prompt folds only when that hides a few lines; folding
 * one stray line costs more than it saves.
 */
const USER_COLLAPSED_LINES = 6
const USER_COLLAPSE_AFTER_LINES = 8
/** Collapsed height. The bubble text is `leading-relaxed` (1.625). */
const USER_COLLAPSED_MAX_HEIGHT = `${USER_COLLAPSED_LINES * 1.625}em`
/** Before layout (first render, no-layout tests): a rough wrap estimate. */
const ESTIMATE_CHARS_PER_LINE = 80
/** Narrower than any real bubble: a hidden or collapsed chat column, not a layout. */
const MIN_MEASURABLE_WIDTH = 120

function estimateWrappedLines(text: string): number {
  return text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / ESTIMATE_CHARS_PER_LINE)), 0)
}

/**
 * Rendered line count of `ref`'s text, kept current as its width changes.
 * `null` until layout can be read. `scrollHeight` is the full text even while
 * a max-height clips it.
 */
function useRenderedLines(ref: React.RefObject<HTMLElement | null>, text: string): number | null {
  const [lines, setLines] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight)
      // A zero-width column wraps one character per line; keep the last
      // reading (or the estimate) until the bubble is laid out for real.
      if (!lineHeight || !el.scrollHeight || el.clientWidth < MIN_MEASURABLE_WIDTH) return
      setLines(Math.round(el.scrollHeight / lineHeight))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, text])
  return lines
}

/** Opens a session in any workspace (the sender or the replier of a workspace message). */
export type OpenSessionHandler = (sessionId: string, workspace: string) => void

const SOURCE_CHIP_CLASS =
  'inline-flex min-h-6 max-w-full items-center gap-1 rounded-xs px-1.5 text-[11px] text-(--color-text-muted) pointer-coarse:min-h-9'

/** "From <workspace> · <session>" above a prompt another workspace's agent sent. */
function SentFromChip({ source, onOpenSession }: { source: SentFrom; onOpenSession?: OpenSessionHandler }) {
  const label = (
    <>
      <span className="shrink-0">From</span>
      <span className="shrink-0 font-mono font-semibold text-(--color-text)">{source.workspaceName}</span>
      {source.sessionTitle && <span className="min-w-0 truncate">· {source.sessionTitle}</span>}
    </>
  )
  const title = `Sent by the agent in ${source.workspace || source.workspaceName}${source.reply ? '; its final answer goes back there' : ''}`
  if (!onOpenSession) {
    return <span className={SOURCE_CHIP_CLASS} title={title} data-sent-from>{label}</span>
  }
  return (
    <button
      type="button"
      onClick={() => onOpenSession(source.sessionId, source.workspace)}
      className={cn(SOURCE_CHIP_CLASS, 'transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40')}
      title={title}
      aria-label={`Open the sending session in ${source.workspaceName}`}
      data-sent-from
    >
      {label}
      <ArrowUpRight size={11} aria-hidden="true" className="shrink-0" />
    </button>
  )
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
        className="inline rounded-sm text-(--accent-blue-text) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
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
  const openAttachment = useContext(FileRefContext)?.openAttachment

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

  // With a dock, a saved upload opens as a tab beside the chat. An optimistic
  // blob URL (still sending) is revoked soon, so it stays in the lightbox.
  const open = (idx: number) => {
    const item = items[idx]
    if (openAttachment && item?.src && !item.src.startsWith('blob:')) openAttachment(item)
    else setLightboxIndex(idx)
  }

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {items.map((item, idx) => (
          <AttachmentThumb
            key={item.src || idx}
            item={item}
            onOpen={() => open(idx)}
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
  const box = useImageBox(item.type === 'image' ? item.src : undefined)

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
          : (
            <img
              src={item.src}
              alt={item.name}
              loading="lazy"
              width={box.width}
              height={box.height}
              data-pending={box.pending ? '' : undefined}
              onLoad={box.onLoad}
              onError={() => setImgError(true)}
              // Held at the failed tile's 120px until the first load, so the
              // bubble does not grow from 0px under the reader.
              className={cn('h-auto max-h-[200px] max-w-[200px] rounded-sm object-cover', box.pending && 'min-h-[120px] min-w-[120px] bg-(--bg-key)')}
            />
          )
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

export const UserBubble = memo(function UserBubble({ content, timestamp, attachments, onEdit, modelId, thinkingLevel, onMentionFileOpen, mentions, fromAgent, sentFrom, replyFrom, onOpenSession, goal = false }: {
  content: string
  timestamp?: Date
  attachments?: MessageAttachment[]
  /** Rewind to just before this prompt and put it back in the composer. */
  onEdit?: () => void
  /** The model and thinking level this prompt ran with. */
  modelId?: string | null
  thinkingLevel?: string | null
  onMentionFileOpen?: (path: string) => void
  mentions?: string[]
  fromAgent?: string | null
  /** Another workspace's agent sent this prompt. */
  sentFrom?: SentFrom | null
  /** This report answers a message sent to another workspace. */
  replyFrom?: ReplyFrom | null
  onOpenSession?: OpenSessionHandler
  /** This prompt set a `/goal`; its text is the objective. */
  goal?: boolean
}) {
  const [showTime, setShowTime] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [reportExpanded, setReportExpanded] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  // Height before an expand/collapse, so the layout effect can animate from it.
  const toggleFromHeight = useRef<number | null>(null)
  const modelName = shortModelName(modelId)
  const chatMenu = useChatMenu(fromAgent ? `Actions for ${fromAgent} report` : 'Actions for message', () => [
    { label: 'Copy', run: () => copyText(content) },
    ...(onEdit && !fromAgent ? [{ label: 'Edit', run: onEdit }] : []),
  ])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  // Design feedback from the Preview tab shows as cards, not raw text; the
  // collapse and mention rendering below only see the typed text.
  const { text, blocks: feedbackBlocks } = splitDesignFeedback(content)
  const lines = text.split('\n')
  const renderedLines = useRenderedLines(textRef, text)
  const needsCollapse = (renderedLines ?? estimateWrappedLines(text)) > USER_COLLAPSE_AFTER_LINES
  const collapsed = needsCollapse && !expanded
  const isSubagentLongReport = content.length > 240 || lines.length > 5
  const visibleAttachments = attachments?.filter((att) => att.source !== 'mention') ?? []

  const toggleExpanded = () => {
    toggleFromHeight.current = textRef.current?.getBoundingClientRect().height ?? null
    setExpanded((v) => !v)
  }

  // Glide between the folded and full height instead of jumping.
  useLayoutEffect(() => {
    const el = textRef.current
    const from = toggleFromHeight.current
    toggleFromHeight.current = null
    if (!el || from === null || typeof el.animate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const to = el.getBoundingClientRect().height
    if (Math.abs(to - from) < 1) return
    el.style.overflow = 'hidden'
    const animation = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: DURATIONS_S.base * 1000,
      easing: `cubic-bezier(${EASINGS.out.join(', ')})`,
    })
    const settle = () => { el.style.overflow = '' }
    animation.onfinish = settle
    animation.oncancel = settle
  }, [expanded])

  if (fromAgent) {
    const reply = replyFrom ?? null
    const sender = reply && onOpenSession ? (
      <button
        type="button"
        onClick={() => onOpenSession(reply.sessionId, reply.workspace)}
        className="inline-flex min-h-5 items-center gap-1 rounded-xs bg-(--bg-key)/70 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-(--color-text) transition-colors hover:bg-(--bg-key) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 pointer-coarse:min-h-9"
        title={reply.workspace}
        aria-label={`Open the replying session in ${reply.workspaceName}`}
      >
        {fromAgent}
        <ArrowUpRight size={11} aria-hidden="true" />
      </button>
    ) : (
      <span className="rounded-xs bg-(--bg-key)/70 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-(--color-text)">
        {fromAgent}
      </span>
    )
    return (
      <div
        className="group mb-3 flex justify-start"
        onMouseEnter={() => setShowTime(true)}
        onMouseLeave={() => setShowTime(false)}
        onContextMenu={chatMenu.onContextMenu}
        onKeyDown={chatMenu.onKeyDown}
      >
        {chatMenu.menu}
        <div className="flex max-w-full flex-col items-start gap-1.5 md:max-w-[85%]">
          <div className="flex items-center gap-1.5 px-0.5 text-xs text-(--color-text-muted)">
            {sender}
            <span className="text-[11px] text-(--color-text-subtle)">{reply ? replyLabel(reply) : 'Subagent report'}</span>
            {timestamp && (
              <span className="text-[11px] text-(--color-text-subtle)">· {formatTime(timestamp)}</span>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors hover:text-(--color-text) focus-visible:outline-none"
              title="Copy report"
              aria-label="Copy report"
            >
              {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
            </button>
          </div>
          <div
            className={cn(
              "relative min-w-0 max-w-full rounded-md border border-(--color-border) bg-(--bg-card) px-3.5 py-2.5 text-sm leading-relaxed text-(--color-text)",
              isSubagentLongReport && !reportExpanded && "max-h-36 overflow-hidden",
            )}
          >
            <MarkdownBlock content={content} />
            {isSubagentLongReport && !reportExpanded && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-(--bg-card) via-(--bg-card)/80 to-transparent" />
            )}
          </div>
          {isSubagentLongReport && (
            <button
              type="button"
              onClick={() => setReportExpanded((v) => !v)}
              aria-expanded={reportExpanded}
              className="mt-0.5 flex items-center gap-1 text-xs font-medium text-(--color-accent) hover:underline focus-visible:outline-none"
            >
              {reportExpanded ? (
                <>
                  <ChevronUp size={13} aria-hidden="true" />
                  <span>Minimize</span>
                </>
              ) : (
                <>
                  <ChevronDown size={13} aria-hidden="true" />
                  <span>Show full report</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="group mb-3 flex justify-end"
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
      onContextMenu={chatMenu.onContextMenu}
      onKeyDown={chatMenu.onKeyDown}
    >
      {chatMenu.menu}
      <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[78%]">
         {sentFrom && <SentFromChip source={sentFrom} onOpenSession={onOpenSession} />}
         {goal && <GoalSetBadge />}
         {/* Attachments */}
         {visibleAttachments.length > 0 && (
           <AttachmentStrip attachments={visibleAttachments} />
         )}

          {/* No shadow: the bubble is a tonal step above the page, not a
              floating layer (see DESIGN.md — Elevation & Depth). */}
          {text && (
          <div className="relative min-w-0 max-w-full overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2.5 text-sm leading-relaxed text-(--color-text) selectable-text">
           {/* Expand / collapse button — top-right inside bubble */}
           {needsCollapse && (
             <Tooltip className="absolute top-1.5 right-1.5 z-10">
               <TooltipTrigger
                 render={
                   <button
                     onClick={toggleExpanded}
                     aria-expanded={expanded}
                     aria-label={expanded ? 'Collapse' : 'Expand'}
                     className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-(--bg-key) text-(--color-text-2) transition-[color,background-color,scale] duration-(--motion-instant) ease-(--ease-in-out) hover:text-(--color-text) active:scale-90"
                   >
                     {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                   </button>
                 }
               />
               <TooltipContent>{expanded ? 'Collapse' : 'Expand'}</TooltipContent>
             </Tooltip>
           )}
           <p
             ref={textRef}
             data-collapsed={collapsed || undefined}
             className={cn('min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere]', needsCollapse && 'pr-6', collapsed && 'overflow-hidden')}
             style={collapsed ? { maxHeight: USER_COLLAPSED_MAX_HEIGHT } : undefined}
           >
             {renderMentionSegments(text, onMentionFileOpen, mentions)}
           </p>
           {/* Gradient fade at bottom when collapsed */}
           {collapsed && (
             <div
                className="pointer-events-none absolute inset-x-0 bottom-0"
               style={{
                 height: '2.4rem',
                 background: 'linear-gradient(to bottom, transparent 0%, var(--bg-card) 90%)',
               }}
             />
           )}
         </div>
          )}

         {feedbackBlocks.map((feedback, index) => (
           <DesignFeedbackCard key={index} feedback={feedback} onMentionFileOpen={onMentionFileOpen} />
         ))}

         {/* Actions + timestamp row. Always rendered: Copy and Edit do not
             depend on the metadata, and a pending prompt has neither yet. */}
            <div className={`flex items-center gap-1.5 transition-opacity duration-(--motion-fast) focus-within:opacity-100 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
              {modelName && (
                <span
                  data-prompt-model
                  className="mr-1 font-mono text-[11px] text-(--color-text-subtle)"
                  title={thinkingLevel ? `Thinking level: ${thinkingLevel}` : undefined}
                >
                  {thinkingLevel ? `${modelName} · ${thinkingLevel}` : modelName}
                </span>
              )}
              {onEdit && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        onClick={onEdit}
                        className="rounded-xs p-0.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 active:scale-90"
                        aria-label="Edit message"
                      >
                        <Pencil size={11} />
                      </button>
                    }
                  />
                  {/* Undo, so later turns come back with Redo. */}
                  <TooltipContent>Edit from here</TooltipContent>
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
      </div>
    </div>
  )
})
