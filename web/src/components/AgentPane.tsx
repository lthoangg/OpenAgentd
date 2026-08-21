/**
 * AgentPane — compact single-agent pane used by the split view.
 *
 * Renders the same ContentBlock[] stream as `AgentView` (see that file for
 * block types) but in a denser layout with a small header (status, lead
 * badge, token totals) for tiling alongside other panes.
 *
 * Blocks are grouped into "turns" via `partitionTurns` (see `utils/turns.ts`):
 * a turn is a contiguous run of non-user blocks. Each finalized turn renders a
 * single `AssistantTurnFooter` (copy + timestamp) via the shared `AssistantTurn`
 * component (see `AssistantTurnFooter.tsx`); only the trailing turn hides its
 * footer while the agent is actively streaming.
 */
import { useState, useCallback, useMemo, memo } from 'react'

import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { ChevronDown, ChevronUp, Copy, Check, Undo2, AlertCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Thinking } from './Thinking'
import { ToolCall } from './ToolCall'
import { MCPAppResult } from './MCPAppResult'
import { InboxBubble } from './InboxBubble'
import { CompactionDivider } from './CompactionDivider'
import { ImageAttachment } from './ImageAttachment'
import { FileCard } from './FileCard'
import { AssistantTurn } from './AssistantTurnFooter'
import { TokenMeter } from '@/components/ui/token-meter'
import { appendCurrentTurns, partitionTurns } from '@/utils/turns'
import { latestDirectUserBlockIdFromParts, liveBlockTail } from '@/utils/blocks'
import { extractSleepPrefix, formatTime, formatFullDateTime } from '@/utils/format'
import { latestMCPAppResourceBlockIdsFromParts, latestMCPAppResources, mcpAppResourceUri } from '@/utils/mcp-app-artifacts'
import { useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'
import { useTeamStore, isAwaitingRestartOutput } from '@/stores/useTeamStore'
import { findCommittedMentions } from './InputComposer.mentions'
import type { AgentStream } from '@/stores/useTeamStore'
import { resolveApiUrl } from '@/api/client'
import { openExternalUrl } from '@/lib/open-external'
import type { ContentBlock, MessageAttachment } from '@/api/types'
import { cn } from '@/lib/utils'

interface AgentPaneProps {
  name: string
  stream: AgentStream
  isLead: boolean
}

const USER_COLLAPSE_LINES = 10
const USER_COLLAPSE_CHARS = 700

function isDirectUserBlock(block: ContentBlock): boolean {
  return block.type === 'user' && !block.extra?.from_agent
}

/** True for a `thinking`/`text` block that has streamed in only whitespace
 *  so far (e.g. a provider's blank reasoning-section separator, or the
 *  very first chunk before real content arrives). Such a block renders no
 *  visible output, so it must not count as "content has started" when
 *  deciding whether to keep showing the pending dots — otherwise the user
 *  is left staring at a blank chat area with no dots and no content. */
function isBlankContentBlock(block: ContentBlock): boolean {
  return (block.type === 'thinking' || block.type === 'text') && block.content.trim().length === 0
}

function shortModelName(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return modelId.split(':').at(-1)?.split('/').at(-1) || modelId
}

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
function renderMentionSegments(content: string, mentions?: string[]): React.ReactNode[] {
  const ranges = findCommittedMentions(content, null, undefined, mentions)
  if (ranges.length === 0) return renderUrlSegments(content, 'url')
  const out: React.ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push(...renderUrlSegments(content.slice(cursor, r.start), `pre-${cursor}`))
    const token = content.slice(r.start, r.end)
    const isFolder = token.endsWith('/')
    out.push(
      <span
        key={r.start}
        data-mention-kind={isFolder ? 'directory' : 'file'}
        className={
          isFolder ? 'text-(--accent-orange-text)' : 'text-(--accent-blue-text)'
        }
      >
        {token}
      </span>,
    )
    cursor = r.end
  }
  if (cursor < content.length) out.push(...renderUrlSegments(content.slice(cursor), `post-${cursor}`))
  return out
}

const UserBubble = memo(function UserBubble({ content, timestamp, attachments, onRevert, modelId, mentions }: { content: string; timestamp?: Date; attachments?: MessageAttachment[]; onRevert?: () => void; modelId?: string | null; mentions?: string[] }) {
  const [showTime, setShowTime] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const modelName = shortModelName(modelId)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }, [content])

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
      <div className="flex max-w-full flex-col items-end gap-1.5 md:max-w-[85%]">
         {/* Attachments (compact) */}
         {visibleAttachments.length > 0 && (
           <div className="flex flex-wrap justify-end gap-1.5">
             {visibleAttachments.map((att: MessageAttachment, idx: number) => {
               const isImage = att.category === 'image'

               if (isImage) {
                 return (
                  <ImageAttachment
                    key={idx}
                    src={resolveApiUrl(att.url) || ''}
                    alt={att.filename || att.original_name || `Attachment ${idx + 1}`}
                  />

                 )
               }

               return (
                  <FileCard
                    key={idx}
                    name={att.filename || att.original_name || `File ${idx + 1}`}
                    mediaType={att.media_type}
                    url={resolveApiUrl(att.url)}
                    clickable={!!att.url}
                  />

               )
             })}
           </div>
         )}

          <div className="relative min-w-0 max-w-full overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-xs leading-relaxed text-(--color-text) shadow-sm selectable-text">
           {/* Expand / collapse button — top-right inside bubble (compact) */}
           {needsCollapse && (
             <Tooltip className="absolute top-1 right-1 z-10">
               <TooltipTrigger
                 render={
                   <button
                     onClick={() => setExpanded((v) => !v)}
                     aria-expanded={expanded}
                     aria-label={expanded ? 'Collapse' : 'Expand'}
                     className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-(--bg-key) text-(--color-text-2) transition-all duration-150 hover:text-(--color-text) active:scale-90"
                   >
                     {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                   </button>
                 }
               />
               <TooltipContent>{expanded ? 'Collapse' : 'Expand'}</TooltipContent>
             </Tooltip>
           )}
           <p className={cn('min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere]', needsCollapse && 'pr-5')}>{renderMentionSegments(visibleContent, mentions)}</p>
           {/* Gradient fade at bottom when collapsed */}
           {needsCollapse && !expanded && (
             <div
                className="pointer-events-none absolute inset-x-0 bottom-0"
               style={{
                 height: '1.9rem',
                 background: 'linear-gradient(to bottom, transparent 0%, var(--bg-card) 90%)',
               }}
             />
           )}
         </div>

         {/* Copy button + timestamp row (compact) */}
          {(timestamp || modelName) && (
            <div className={`flex items-center gap-1 transition-opacity duration-150 ${showTime ? 'opacity-100' : 'opacity-0'}`}>
              {modelName && (
                <span className="mr-1 font-mono text-[10px] text-(--color-text-subtle)">{modelName}</span>
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
                        <Undo2 size={10} />
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
                        <Check size={10} className="text-(--color-success)" />
                      ) : (
                        <Copy size={10} />
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


const BlockRenderer = memo(function BlockRenderer({ block, isStreaming, sessionId, onRevert, latestMCPAppBlockIds }: { block: ContentBlock; isStreaming: boolean; sessionId?: string; onRevert?: () => void; latestMCPAppBlockIds?: Set<string> }) {
  switch (block.type) {
    case 'user': {
      const fromAgent = block.extra?.from_agent as string | undefined
      if (fromAgent && fromAgent !== 'user') {
        return <InboxBubble content={block.content} fromAgent={fromAgent} compact />
      }
      const blockModel = typeof block.extra?.model === 'string' ? block.extra.model : null
      return <UserBubble content={block.content} timestamp={block.timestamp} attachments={block.attachments} onRevert={onRevert} modelId={blockModel} mentions={block.extra?.mentions as string[] | undefined} />
    }
    case 'thinking':
      return <Thinking content={block.content} isStreaming={isStreaming} />
    case 'compaction': {
      const state = block.extra?.state === 'compacting' ? 'compacting' : 'compacted'
      const error = Boolean(block.extra?.error)
      return (
        <CompactionDivider
          state={state}
          error={error}
          summary={block.content}
          sessionId={sessionId}
          isStreaming={isStreaming}
        />
      )
    }
    case 'provider_status': {
      const status = block.extra?.status
      const title = (block.extra?.title as string) || (status === 'error' || status === 'exhausted' ? 'Provider Error' : undefined)
      const customMsg = block.extra?.message as string | undefined

      if (status === 'error' || status === 'exhausted' || block.extra?.category === 'provider') {
        return (
          <div className="my-2 rounded-md border border-(--color-error)/30 bg-(--color-error-subtle) px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-(--color-error)">
              <AlertCircle size={14} className="shrink-0" />
              <span>{title || 'Provider Error'}</span>
            </div>
            <p className="mt-1 text-(--color-error)/90 leading-relaxed break-words">{customMsg || block.content}</p>
          </div>
        )
      }

      const model = block.extra?.model
      const attempt = block.extra?.attempt
      const maxAttempts = block.extra?.max_attempts
      const delay = block.extra?.delay_seconds
      const errorType = block.extra?.error_type
      const statusCode = block.extra?.status_code
      let message = 'Provider status updated.'
      if (status === 'retrying') {
        const delayText = typeof delay === 'number' ? ` Waiting ${delay.toFixed(1)}s.` : ''
        const errorText = errorType ? ` after ${String(errorType)}${statusCode ? ` ${String(statusCode)}` : ''}` : ''
        message = `Retrying ${String(model ?? 'model')} (${String(attempt ?? '?')}/${String(maxAttempts ?? '?')})${errorText}.${delayText}`
      }
      return <p className="rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-xs text-(--color-text-muted)">{message}</p>
    }
    case 'tool': {
      const mcpApp = (block.extra as { mcp_app?: unknown } | undefined)?.mcp_app
      return (
        <div>
          <ToolCall
            name={block.toolName || ''}
            args={block.toolArgs}
            done={block.toolDone}
            liveOutput={block.toolOutput}
            result={block.toolResult}
            durationMs={block.durationMs}
            startedAt={block.startedAt}
            toolCallId={block.toolCallId}
          />
          {block.toolDone && Boolean(mcpApp) && latestMCPAppBlockIds?.has(block.id) ? (
            <div className="mt-2">
              <MCPAppResult mcpApp={mcpApp as never} sessionId={sessionId} toolCallId={block.toolCallId} />
            </div>
          ) : null}
        </div>
      )
    }
    case 'text': {
      // Me sleep sentinel — show any preceding content normally, then append idle pill
      const sleepPrefix = extractSleepPrefix(block.content)
      if (sleepPrefix !== null) {
        return (
          <div>
            {sleepPrefix && <LazyMarkdownBlock content={sleepPrefix} sessionId={sessionId} />}
            <p className="text-xs text-(--color-text-subtle) italic">— idle —</p>
          </div>
        )
      }
      return (
        <div>
          <LazyMarkdownBlock content={block.content} sessionId={sessionId} isStreaming={isStreaming} />
        </div>
      )
    }
    default:
      return null
  }
})

/**
 * Memoised because `SplitGrid` subscribes to the whole `agentStreams` map, whose
 * identity changes on every ~16ms SSE delta batch (immer copy-on-write walks up
 * to the root). Without this gate, a token streamed into one pane re-rendered
 * every other pane in the grid. Each agent's `stream` object only changes when
 * that agent's own state does, so a shallow prop compare is exactly the right
 * boundary — keep every prop passed here referentially stable (`onContinue` is
 * a Zustand action, which is stable for the store's lifetime).
 */
  export const AgentPane = memo(function AgentPane({
  name, stream, isLead,
}: AgentPaneProps) {
  const sessionId = useTeamStore((s) => s.sessionId) ?? undefined
  const handleRevert = useCallback(() => {
    void useTeamStore.getState().undoTeam().then(async (response) => {
      const message = response?.message
      if (!message || message.role !== 'user' || message.is_summary) return
      window.dispatchEvent(
        new CustomEvent('undo:restore-draft', {
          detail: { content: message.content ?? '', attachments: message.attachments ?? [] },
        }),
      )
    })
  }, [])
  const isWorking = stream.status === 'working'
  const isError   = stream.status === 'error'
  const isOffline = stream.status === 'offline'
  // Suspended on `ask_user`: the turn is open but nothing is running,
  // so this reads as neither working nor idle.
  const isWaiting = stream.status === 'waiting_input'
  // Me show waiting indicator when a user message exists but the agent hasn't woken yet.
  // Excludes `isWaiting`: a lead parked on a question is not "about to respond",
  // and bouncing dots under its own question card read as work in progress.
  const isPending = !isWorking && !isWaiting && !isError && !isOffline && stream.currentBlocks.some(isDirectUserBlock)

  // Live blocks not yet folded into `stream.blocks`, deduped against
  // confirmed ids — the same array feeds scroll bookkeeping and turn
  // partitioning below so they can't disagree about what actually renders.
  const liveTail = useMemo(
    () => liveBlockTail(stream.blocks, stream.currentBlocks),
    [stream.blocks, stream.currentBlocks],
  )
  const totalLen = stream.blocks.length + liveTail.length
  const latestUserBlockId = useMemo(
    () => latestDirectUserBlockIdFromParts(stream.blocks, stream.currentBlocks),
    [stream.blocks, stream.currentBlocks],
  )
  const finalizedTurnItems = useMemo(() => partitionTurns(stream.blocks), [stream.blocks])
  const turnItems = useMemo(
    () => appendCurrentTurns(finalizedTurnItems, stream.blocks.length, liveTail),
    [finalizedTurnItems, stream.blocks.length, liveTail],
  )
  const finalizedMCPAppResources = useMemo(() => latestMCPAppResources(stream.blocks), [stream.blocks])
  const latestMCPAppBlockIds = useMemo(
    () => latestMCPAppResourceBlockIdsFromParts(finalizedMCPAppResources, stream.currentBlocks),
    [finalizedMCPAppResources, stream.currentBlocks],
  )

  const lastBlock = liveTail.length > 0 ? liveTail[liveTail.length - 1] : stream.blocks[stream.blocks.length - 1]
  const lastBlockContent = lastBlock
    ? `${lastBlock.content ?? ''}:${lastBlock.toolOutput ?? ''}:${lastBlock.toolResult ?? ''}:${lastBlock.toolArgs ?? ''}`
    : ''
  const isUserMessage = lastBlock ? isDirectUserBlock(lastBlock) : false
  const isEmpty = totalLen === 0

  const {
    scrollRef,
    contentRef,
    anchorRef,
    showScrollBtn,
    scrollToBottom,
  } = useAutoFollowScroll({
    totalLen,
    lastContent: lastBlockContent,
    sessionId,
    isUserMessage,
    isEmpty,
  })

  const borderClass = isError
    ? 'border-(--color-error)'
    : isLead
    ? 'border-(--color-border-strong)'
    : 'border-(--color-border)'
  const headerAccent = isError ? 'border-b-(--color-error)' : isWorking ? 'border-b-(--color-accent)' : isOffline ? 'border-b-(--color-text-subtle)' : isLead ? 'border-b-(--color-border-strong)' : 'border-b-(--color-border)'

  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-sm border bg-(--bg-page) transition-colors duration-150 ${borderClass}`}
    >
      {/* Header */}
      <div className={`flex items-center gap-2 border-b bg-(--bg-sidebar) px-3 py-2 ${headerAccent}`}>
         <div className="flex min-w-0 flex-1 items-center gap-1.5">
           <span className={`truncate text-xs font-semibold ${isLead ? 'text-(--color-text)' : 'text-(--color-text-2)'}`}>
             {name}
           </span>
           {isLead && (
             <span className="shrink-0 rounded-xs border border-(--color-border) bg-(--bg-key)/60 px-1 py-0.5 text-[10px] text-(--color-text-2)">
               lead
             </span>
           )}
         </div>
         <div className="flex items-center gap-1 text-xs text-(--color-text-subtle)">
           {!isLead && (stream.usage.totalTokens > 0 || isWorking || isWaiting) && (
             <TokenMeter
               input={stream.usage.promptTokens}
               output={stream.usage.completionTokens}
               cached={stream.usage.cachedTokens}
               cachedPercent={stream.usage.cachedPercent}
             />
           )}
            <span aria-label={isWaiting ? 'Agent status: waiting for your input' : `Agent status: ${stream.status}`} className={`h-1.5 w-1.5 rounded-full ${
             isError ? 'bg-(--color-error)' : isWorking ? 'bg-(--color-accent)' : isWaiting ? 'animate-pulse bg-(--color-warning)' : isOffline ? 'bg-(--color-text-subtle) opacity-50' : 'bg-(--color-success)'
           }`} />
         </div>
       </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="oa-chat-scroll flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {isEmpty && !isWorking && (isError || isOffline) && (
            <div className="flex h-full select-none flex-col items-center justify-center py-8">
              <p className="text-xs text-(--color-text-subtle)">{isError ? stream.lastError || 'Error' : 'Offline'}</p>
            </div>
          )}

         {totalLen > 0 && (
            <div ref={contentRef} className="space-y-3 px-2.5 py-2.5">
               {turnItems.map((item, k) => {
                   if (item.kind === 'user') {
                     return (
                       <BlockRenderer
                         key={item.block.id}
                         block={item.block}
                         isStreaming={false}
                           sessionId={sessionId}
                           onRevert={item.block.id === latestUserBlockId ? handleRevert : undefined}
                           latestMCPAppBlockIds={mcpAppResourceUri(item.block) ? latestMCPAppBlockIds : undefined}
                          />
                     )
                   }
                   // Me only the trailing turn (no user block after) can be "live"
                    const isTrailingTurn = k === turnItems.length - 1
                   return (
                     <AssistantTurn
                       key={`turn-${item.startIndex}-${item.blocks[0]?.id ?? k}`}
                       blocks={item.blocks}
                       startIndex={item.startIndex}
                       finalizedCount={stream.blocks.length}
                       isWorking={isWorking}
                        isTurnOpen={isWorking || isWaiting}
                        isTrailingTurn={isTrailingTurn}
                        totalBlocks={totalLen}
                        renderBlock={({ block, isStreaming }) => (
                         <BlockRenderer
                           block={block}
                           isStreaming={isStreaming}
                            sessionId={sessionId}
                            latestMCPAppBlockIds={mcpAppResourceUri(block) ? latestMCPAppBlockIds : undefined}
                          />
                       )}
                     />
                   )
                  })}
            </div>
          )}

          <div ref={anchorRef} data-chat-scroll-anchor aria-hidden="true" />

          {/* Me show dots when pending (user sent, agent not woken), restarting
              after an answered question (no new user block, blocks still hold
              the suspended turn), or working with no visible agent content yet. */}
          {(isPending ||
            isAwaitingRestartOutput(stream) ||
            (isWorking && stream.currentBlocks.every((b) => b.type === 'user' || isBlankContentBlock(b)))) && (
            <div className="flex items-center gap-1.5 px-3 pt-3" role="status" aria-label={`${name} is preparing a response`}>
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '0ms' }} />
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '150ms' }} />
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-(--color-accent)" style={{ animationDelay: '300ms' }} />
            </div>
          )}

          {isError && stream.lastError && (
           <div className="mx-3 mt-3 rounded-sm border border-(--color-error) bg-(--color-error-subtle) px-3 py-2">
             <p className="text-xs text-(--color-error)">{stream.lastError}</p>
           </div>
          )}
      </div>
      {showScrollBtn && (
        <button
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={16} />
        </button>
      )}
      </div>
    </div>
  )
})
