/**
 * AgentPane — compact single-agent pane used by split and unified views.
 *
 * Renders the same ContentBlock[] stream as `AgentView` (see that file for
 * block types) but in a denser layout with header chrome (status, drag handle,
 * close button) for tiling alongside other panes.
 *
 * Blocks are grouped into "turns" via `partitionTurns` (see `utils/turns.ts`):
 * a turn is a contiguous run of non-user blocks. Each finalized turn renders a
 * single `AssistantTurnFooter` (copy + timestamp) via the shared `AssistantTurn`
 * component (see `AssistantTurnFooter.tsx`); only the trailing turn hides its
 * footer while the agent is actively streaming.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import OctobotMascot from '@/assets/brand/octobot-agentd-source.png'

import { MarkdownBlock } from '@/utils/markdown'
import { ChevronDown, ChevronUp, X, Copy, Check, GripVertical } from 'lucide-react'
import { Thinking } from './Thinking'
import { ToolCall } from './ToolCall'
import { InboxBubble } from './InboxBubble'
import { StreamingCursor } from './motion'
import { ImageAttachment } from './ImageAttachment'
import { FileCard } from './FileCard'
import { AssistantTurn } from './AssistantTurnFooter'
import { partitionTurns } from '@/utils/turns'
import { formatTokens, extractSleepPrefix, formatTime } from '@/utils/format'
import { useTeamStore } from '@/stores/useTeamStore'
import type { AgentStream } from '@/stores/useTeamStore'
import type { ContentBlock, MessageAttachment } from '@/api/types'

interface AgentPaneProps {
  name: string
  stream: AgentStream
  isLead: boolean
  // Unified view
  isFocused?: boolean
  onClose?: () => void
  onFocus?: () => void
  // Shared drag state
  isDropTarget?: boolean
  isDragging?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  // Split-grid drag (index-based)
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop?: () => void
}

const USER_COLLAPSE_LINES = 10

function UserBubble({ content, timestamp, attachments }: { content: string; timestamp?: Date; attachments?: MessageAttachment[] }) {
  const [showTime, setShowTime] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

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
  const needsCollapse = lines.length > USER_COLLAPSE_LINES
  const visibleContent = needsCollapse && !expanded
    ? lines.slice(0, USER_COLLAPSE_LINES).join('\n')
    : content

  return (
    <div
      className="group mb-3 flex justify-end"
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
    >
      <div className="flex max-w-[85%] flex-col items-end gap-1.5">
         {/* Attachments (compact) */}
         {attachments && attachments.length > 0 && (
           <div className="flex flex-wrap justify-end gap-1.5">
             {attachments.map((att: MessageAttachment, idx: number) => {
               const isImage = att.category === 'image'

               if (isImage) {
                 return (
                   <ImageAttachment
                     key={idx}
                     src={att.url || ''}
                     alt={att.original_name || `Attachment ${idx + 1}`}
                   />
                 )
               }

               return (
                 <FileCard
                   key={idx}
                   name={att.original_name || att.filename || `File ${idx + 1}`}
                   mediaType={att.media_type}
                   url={att.url}
                   clickable={!!att.url}
                 />
               )
             })}
           </div>
         )}

         <div className="relative rounded-2xl rounded-br-sm bg-(--color-accent) px-3 py-2 text-xs leading-relaxed text-(--color-bg) overflow-hidden">
           {/* Expand / collapse button — top-right inside bubble (compact) */}
           {needsCollapse && (
             <button
               onClick={() => setExpanded((v) => !v)}
               aria-expanded={expanded}
               title={expanded ? 'Collapse' : 'Expand'}
               className={[
                 'absolute top-1 right-1',
                 'flex items-center justify-center shrink-0',
                 'rounded-md',
                 'h-4 w-4',
                 'transition-all duration-150',
                 'active:scale-90',
               ].join(' ')}
               style={{
                 background: 'rgba(0,0,0,0.15)',
                 color: 'var(--color-bg)',
               }}
             >
               {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
             </button>
           )}
           <p className="whitespace-pre-wrap">{visibleContent}</p>
           {/* Gradient fade at bottom when collapsed */}
           {needsCollapse && !expanded && (
             <div
               className="pointer-events-none absolute inset-x-0 bottom-0"
               style={{
                 height: '1.9rem',
                 background: 'linear-gradient(to bottom, transparent 0%, var(--color-accent) 90%)',
               }}
             />
           )}
         </div>

         {/* Copy button + timestamp row (compact) */}
         {timestamp && (
           <div className={`flex items-center gap-1 transition-opacity duration-150 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
             <button
               onClick={handleCopy}
               className="rounded p-0.5 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
               aria-label="Copy message"
               title="Copy"
             >
               {copied ? (
                 <Check size={10} className="text-(--color-success)" />
               ) : (
                 <Copy size={10} />
               )}
             </button>
             <span
               className="text-xs text-(--color-text-subtle)"
               aria-hidden={!showTime}
               title={formatTime(timestamp)}
             >
               {formatTime(timestamp)}
             </span>
           </div>
         )}
       </div>
    </div>
  )
}


function BlockRenderer({ block, isStreaming, isLast, sessionId }: { block: ContentBlock; isStreaming: boolean; isLast: boolean; sessionId?: string }) {
  switch (block.type) {
    case 'user': {
      const fromAgent = block.extra?.from_agent as string | undefined
      if (fromAgent && fromAgent !== 'user') {
        return <InboxBubble content={block.content} fromAgent={fromAgent} compact />
      }
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} />
    }
    case 'thinking':
      return <Thinking content={block.content} isStreaming={isStreaming} />
    case 'tool':
      return (
        <ToolCall
          name={block.toolName || ''}
          args={block.toolArgs}
          done={block.toolDone}
          result={block.toolResult}
        />
      )
    case 'text': {
      // Me sleep sentinel — show any preceding content normally, then append idle pill
      const sleepPrefix = extractSleepPrefix(block.content)
      if (sleepPrefix !== null) {
        return (
          <div>
            {sleepPrefix && <MarkdownBlock content={sleepPrefix} sessionId={sessionId} />}
            <p className="text-xs text-(--color-text-subtle) italic">— idle —</p>
          </div>
        )
      }
      return (
        <div>
          <MarkdownBlock content={block.content} sessionId={sessionId} />
          {isStreaming && isLast && (
            <StreamingCursor className="ml-0.5 text-(--color-accent)" />
          )}
        </div>
      )
    }
    default:
      return null
  }
}

export function AgentPane({
  name, stream, isLead,
  isFocused = false,
  isDropTarget = false,
  isDragging = false,
  onClose,
  onFocus,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: AgentPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionId = useTeamStore((s) => s.sessionId) ?? undefined
  const isWorking = stream.status === 'working'
  const isError   = stream.status === 'error'
  // Me show waiting indicator when a user message exists but the agent hasn't woken yet
  const isPending = !isWorking && !isError && stream.currentBlocks.some((b) => b.type === 'user')

  const pinnedRef = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const SCROLL_THRESHOLD = 40

  const isAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setShowScrollBtn(false)
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  // Me detect user scroll via wheel/touchmove — never fires from programmatic scroll
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onUserScroll = () => {
      requestAnimationFrame(() => {
        const atBottom = isAtBottom()
        pinnedRef.current = atBottom
        setShowScrollBtn(!atBottom)
      })
    }
    el.addEventListener('wheel', onUserScroll, { passive: true })
    el.addEventListener('touchmove', onUserScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onUserScroll)
      el.removeEventListener('touchmove', onUserScroll)
    }
  }, [isAtBottom])

  const allBlocks = [...stream.blocks, ...stream.currentBlocks]

  // Me single scroll effect — block count or last block text changed
  const lastBlockContent = allBlocks[allBlocks.length - 1]?.content ?? ''
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allBlocks.length, lastBlockContent])

  const isEmpty = allBlocks.length === 0

  const borderClass  = isError
    ? 'border-(--color-error)'
    : isDropTarget
    ? 'border-(--color-info) bg-(--color-info-subtle)'
    : isFocused
    ? 'border-(--color-accent)'
    : isLead
    ? 'border-(--color-border-strong)'
    : 'border-(--color-border)'
  const headerAccent = isError ? 'border-b-(--color-error)' : isWorking ? 'border-b-(--color-accent)' : isLead ? 'border-b-(--color-border-strong)' : 'border-b-(--color-border)'

  // Drag model (both split-grid and unified modes):
  //   • Only the GripVertical handle initiates drag (draggable lives on the handle).
  //   • The whole panel is a drop target (onDragOver + onDrop on the root).
  // This avoids conflicts with text selection inside the markdown body and
  // prevents the floating input from stealing mousedowns on full-height panes.
  const hasDragHandle = !!onDragStart

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`flex h-full flex-col overflow-hidden rounded-xl border bg-(--color-bg) transition-all duration-150 ${borderClass} ${isDragging ? 'opacity-50' : ''}`}
      onClick={onFocus}
    >
      {/* Header */}
      <div className={`flex items-center gap-2 border-b px-3 py-2.5 ${headerAccent}`}>
         {/* Grip handle — only element that initiates drag */}
         {hasDragHandle && (
           <div
             draggable
             onDragStart={onDragStart}
             onDragEnd={onDragEnd}
             className="cursor-grab text-(--color-text-subtle) hover:text-(--color-text-muted) active:cursor-grabbing"
             onClick={(e) => e.stopPropagation()}
             title="Drag to swap pane position"
             aria-label={`Drag ${name} pane`}
           >
             <GripVertical size={14} />
           </div>
         )}
         <div className="flex min-w-0 flex-1 items-center gap-1.5">
           <span className={`truncate text-xs font-semibold ${isLead ? 'text-(--color-text)' : 'text-(--color-text-2)'}`}>
             {name}
           </span>
           {isLead && (
             <span className="shrink-0 rounded-sm bg-(--color-accent-subtle) px-1 py-0.5 text-xs text-(--color-accent)">
               lead
             </span>
           )}
         </div>
         <div className="flex items-center gap-1 text-xs text-(--color-text-subtle)">
           {stream.usage.totalTokens > 0 && (
             <>
               <span>in {formatTokens(stream.usage.promptTokens)}</span>
               <span className="text-[#3c3836]">·</span>
               <span>out {formatTokens(stream.usage.completionTokens)}</span>
               {stream.usage.cachedTokens > 0 && (
                 <>
                   <span className="text-[#3c3836]">·</span>
                   <span className="text-[#458588]">cached {formatTokens(stream.usage.cachedTokens)}</span>
                 </>
               )}
               {stream.model && <span className="text-[#3c3836]">·</span>}
             </>
           )}
           {stream.model && (
             <span className="text-(--color-text-muted)">{stream.model}</span>
           )}
           <span className={`h-1.5 w-1.5 rounded-full ${
             isError ? 'bg-(--color-error)' : isWorking ? 'animate-pulse bg-(--color-accent)' : 'bg-(--color-success)'
           }`} />
         </div>
         {onClose && (
           <button
             onClick={(e) => { e.stopPropagation(); onClose() }}
             className="ml-1 rounded p-0.5 text-(--color-text-subtle) transition-colors hover:bg-(--color-accent-subtle) hover:text-(--color-text-2)"
             title="Minimize pane"
             aria-label={`Minimize ${name} pane`}
           >
             <X size={12} />
           </button>
         )}
       </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {isEmpty && !isWorking && (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-8">
              <img src={OctobotMascot} className="opacity-30 grayscale" width={56} height={56} alt="Idle octobot" />
              <p className="text-xs text-(--color-text-subtle)">{isError ? stream.lastError || 'Error' : 'Waiting…'}</p>
            </div>
          )}

         {allBlocks.length > 0 && (
            <div className="space-y-3 px-3 py-3">
               {(() => {
                 const items = partitionTurns(allBlocks)
                 return items.map((item, k) => {
                   if (item.kind === 'user') {
                     return (
                       <BlockRenderer
                         key={item.block.id}
                         block={item.block}
                         isStreaming={false}
                         isLast={item.index === allBlocks.length - 1}
                         sessionId={sessionId}
                       />
                     )
                   }
                   // Me only the trailing turn (no user block after) can be "live"
                   const isTrailingTurn = k === items.length - 1
                   return (
                     <AssistantTurn
                       key={`turn-${item.startIndex}-${item.blocks[0]?.id ?? k}`}
                       blocks={item.blocks}
                       startIndex={item.startIndex}
                       finalizedCount={stream.blocks.length}
                       isWorking={isWorking}
                       isTrailingTurn={isTrailingTurn}
                       totalBlocks={allBlocks.length}
                       renderBlock={({ block, isStreaming, isLast }) => (
                         <BlockRenderer
                           block={block}
                           isStreaming={isStreaming}
                           isLast={isLast}
                           sessionId={sessionId}
                         />
                       )}
                     />
                   )
                 })
               })()}
             </div>
           )}

          {/* Me show dots when pending (user sent, agent not woken) or working with no agent content yet.
            * `[].every()` returns true, so the working branch also requires a non-empty
            * currentBlocks list — otherwise dots persist after `done` flushes the buffer
            * if a stale `working` status briefly survives. */}
          {(isPending ||
            (isWorking && stream.currentBlocks.length > 0 &&
              stream.currentBlocks.every((b) => b.type === 'user'))) && (
            <div className="flex items-center gap-1.5 px-3 pt-3">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '0ms' }} />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '150ms' }} />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '300ms' }} />
            </div>
          )}

          {isError && stream.lastError && (
           <div className="mx-3 mt-3 rounded-lg border border-(--color-error) bg-(--color-error-subtle) px-3 py-2">
             <p className="text-xs text-(--color-error)">{stream.lastError}</p>
           </div>
          )}
      </div>
      {showScrollBtn && (
        <button
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-(--color-border) bg-(--color-surface) p-1 text-(--color-text-muted) transition-colors hover:text-(--color-text-2)"
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={12} />
        </button>
      )}
      </div>
    </div>
  )
}
